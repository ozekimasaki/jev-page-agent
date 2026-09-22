/**
 * Interactive-element extraction.
 *
 * Turns the live DOM into a list of indexed interactive elements and
 * text lines (`[i]<tag attrs>text />`) that Jev can choose between.
 * Inspired by browser-use / alibaba page-agent's simplified HTML.
 */

const INTERACTIVE_SELECTOR = [
	'a[href]',
	'button',
	'input',
	'textarea',
	'select',
	'summary',
	'label',
	'[role="button"]',
	'[role="link"]',
	'[role="checkbox"]',
	'[role="radio"]',
	'[role="switch"]',
	'[role="tab"]',
	'[role="menuitem"]',
	'[role="option"]',
	'[role="combobox"]',
	'[role="searchbox"]',
	'[role="slider"]',
	'[role="spinbutton"]',
	'[onclick]',
	'[contenteditable=""]',
	'[contenteditable="true"]',
	'[data-scrollable]',
].join(',')

const INCLUDE_ATTRIBUTES = [
	'type',
	'name',
	'id',
	'for',
	'value',
	'placeholder',
	'aria-label',
	'role',
	'checked',
	'selected',
	'expanded',
	'href',
	'title',
	'alt',
	'target',
]

const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image'])

const MAX_ELEMENT_TEXT = 80
const MAX_ATTR_VALUE = 40
const MAX_PAGE_TEXT = 4000

export interface IndexedElement {
	index: number
	element: HTMLElement
	/** the `[i]<tag attrs>text />` line */
	line: string
	tagName: string
	editable: boolean
	disabled: boolean
	scrollable: boolean
}

export interface PageSnapshot {
	url: string
	title: string
	/** joined `[i]<...>` lines — the "simplified HTML" */
	elementsText: string
	elements: IndexedElement[]
	/** visible text of the page, capped */
	pageText: string
	viewportWidth: number
	viewportHeight: number
	pixelsAbove: number
	pixelsBelow: number
	totalPages: number
	currentPagePosition: number
}

function isHidden(element: Element, view: Window): boolean {
	if ((element as HTMLElement).hidden) return true
	if (element.getAttribute('aria-hidden') === 'true') return true
	let style: CSSStyleDeclaration | null = null
	try {
		style = view.getComputedStyle(element)
	} catch {
		return false
	}
	return style.display === 'none' || style.visibility === 'hidden'
}

function isVisible(element: Element, view: Window): boolean {
	let current: Element | null = element
	while (current) {
		if (isHidden(current, view)) return false
		current = current.parentElement
	}
	// In a real browser a rendered element has a non-empty rect; in jsdom
	// everything has a zero rect, so only apply the rect check when any
	// element on the page reports a layout box.
	const rects = element.getClientRects()
	if (rects.length > 0) return true
	if ((element as HTMLElement).offsetWidth > 0 || (element as HTMLElement).offsetHeight > 0)
		return true
	// No layout engine (jsdom): treat as visible.
	return element.ownerDocument === element.getRootNode()
}

function isDisabled(element: Element): boolean {
	if (element.hasAttribute('disabled')) return true
	const aria = element.getAttribute('aria-disabled')
	return aria === 'true'
}

function isEditable(element: HTMLElement): boolean {
	const tag = element.tagName.toLowerCase()
	if (tag === 'textarea') return true
	if (tag === 'select') return true
	if (element.isContentEditable) return true
	if (tag === 'input') {
		const type = (element.getAttribute('type') ?? 'text').toLowerCase()
		return !SKIP_INPUT_TYPES.has(type)
	}
	return false
}

function isScrollable(element: HTMLElement): boolean {
	if (element.hasAttribute('data-scrollable')) return true
	try {
		const style = element.ownerDocument.defaultView?.getComputedStyle(element)
		if (!style) return false
		const y = style.overflowY
		if ((y === 'auto' || y === 'scroll') && element.scrollHeight > element.clientHeight + 4)
			return true
		const x = style.overflowX
		if ((x === 'auto' || x === 'scroll') && element.scrollWidth > element.clientWidth + 4)
			return true
	} catch {
		// jsdom has no layout — fall through
	}
	return false
}

function cap(text: string, max: number): string {
	return text.length > max ? text.slice(0, max - 3) + '...' : text
}

function elementLine(index: number, element: HTMLElement, flags: { disabled: boolean; scrollable: boolean }): string {
	const tag = element.tagName.toLowerCase()
	const attrs: string[] = []
	for (const name of INCLUDE_ATTRIBUTES) {
		const value = element.getAttribute(name)
		if (value === null || value === '') continue
		// Keep it short and single-line.
		const cleaned = cap(value.replace(/\s+/g, ' ').trim(), MAX_ATTR_VALUE)
		if (cleaned) attrs.push(`${name}=${cleaned}`)
	}
	let text = ''
	try {
		text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim()
	} catch {
		text = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
	}
	text = cap(text, MAX_ELEMENT_TEXT)

	let line = `[${index}]<${tag}`
	if (attrs.length) line += ' ' + attrs.join(' ')
	if (flags.scrollable) line += ' data-scrollable'
	if (text) line += `>${text}`
	line += ' />'
	if (flags.disabled) line += ' (disabled)'
	return line
}

export interface SnapshotOptions {
	/** root to extract from (default: document) */
	root?: ParentNode
	/** extra elements to mark interactive (querySelectorAll selectors) */
	extraSelectors?: string[]
	/** skip these elements (querySelectorAll selectors) */
	blacklist?: string[]
	/** cap for page text (default 4000) */
	maxPageText?: number
}

export function snapshotPage(options: SnapshotOptions = {}): PageSnapshot {
	const root = options.root ?? document
	const doc = root instanceof Document ? root : root.ownerDocument ?? document
	const view = doc.defaultView ?? window

	const selector = options.extraSelectors?.length
		? `${INTERACTIVE_SELECTOR},${options.extraSelectors.join(',')}`
		: INTERACTIVE_SELECTOR

	const blacklist = new Set<Element>()
	for (const sel of options.blacklist ?? []) {
		for (const el of Array.from(root.querySelectorAll(sel))) blacklist.add(el)
	}

	const seen = new Set<Element>()
	const elements: IndexedElement[] = []
	const lines: string[] = []

	for (const el of Array.from(root.querySelectorAll(selector))) {
		if (!(el instanceof view.HTMLElement)) continue
		if (seen.has(el) || blacklist.has(el)) continue
		seen.add(el)

		// Skip hidden inputs entirely; other hidden elements too.
		if (!isVisible(el, view)) continue

		const index = elements.length
		const flags = { disabled: isDisabled(el), scrollable: isScrollable(el) }
		const line = elementLine(index, el, flags)
		elements.push({
			index,
			element: el,
			line,
			tagName: el.tagName.toLowerCase(),
			editable: isEditable(el),
			disabled: flags.disabled,
			scrollable: flags.scrollable,
		})
		lines.push(line)
	}

	let pageText = ''
	try {
		pageText = ((doc.body as HTMLElement | null)?.innerText ?? doc.body?.textContent ?? '') as string
	} catch {
		pageText = doc.body?.textContent ?? ''
	}
	pageText = cap(pageText.replace(/\n{3,}/g, '\n\n').trim(), options.maxPageText ?? MAX_PAGE_TEXT)

	const scrollY = view.scrollY ?? 0
	const viewportHeight = view.innerHeight ?? 0
	const pageHeight = doc.documentElement?.scrollHeight ?? viewportHeight
	const pixelsAbove = Math.max(0, Math.round(scrollY))
	const pixelsBelow = Math.max(0, Math.round(pageHeight - scrollY - viewportHeight))
	const totalPages = viewportHeight > 0 ? pageHeight / viewportHeight : 1

	return {
		url: view.location.href,
		title: doc.title ?? '',
		elementsText: lines.join('\n'),
		elements,
		pageText,
		viewportWidth: view.innerWidth ?? 0,
		viewportHeight,
		pixelsAbove,
		pixelsBelow,
		totalPages,
		currentPagePosition: pageHeight > 0 ? scrollY / Math.max(1, pageHeight - viewportHeight) : 0,
	}
}
