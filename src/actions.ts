/**
 * DOM actions the agent can perform on indexed elements.
 * Each action returns a short result string for the agent's history.
 */
import type { IndexedElement, PageSnapshot } from './dom.js'

export class ActionError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ActionError'
	}
}

/** Briefly outline an element so a human can see what the agent is doing. */
export function highlight(element: HTMLElement, ms = 350): void {
	const view = element.ownerDocument?.defaultView
	if (!view) return
	const previous = element.style.outline
	element.style.outline = '3px solid #6366f1'
	view.setTimeout(() => {
		element.style.outline = previous
	}, ms)
}

export function clickElement(target: IndexedElement): string {
	if (target.disabled) throw new ActionError(`Element ${target.index} is disabled`)
	highlight(target.element)
	target.element.click()
	return `✅ Clicked element ${target.index} (${target.line})`
}

function dispatchInputEvents(element: HTMLElement): void {
	const view = element.ownerDocument?.defaultView
	if (!view) return
	for (const type of ['input', 'change']) {
		element.dispatchEvent(new view.Event(type, { bubbles: true }))
	}
}

export function inputText(target: IndexedElement, text: string): string {
	const el = target.element
	if (target.disabled) throw new ActionError(`Element ${target.index} is disabled`)
	highlight(el)

	if (el instanceof (el.ownerDocument.defaultView?.HTMLInputElement ?? Object)) {
		const input = el as HTMLInputElement
		const proto = Object.getPrototypeOf(input)
		const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
		input.focus()
		if (setter) setter.call(input, text)
		else input.value = text
		dispatchInputEvents(input)
		return `✅ Input "${text}" into element ${target.index}`
	}
	if (el instanceof (el.ownerDocument.defaultView?.HTMLTextAreaElement ?? Object)) {
		const textarea = el as HTMLTextAreaElement
		textarea.focus()
		textarea.value = text
		dispatchInputEvents(textarea)
		return `✅ Input "${text}" into element ${target.index}`
	}
	if ((el as HTMLElement).isContentEditable) {
		;(el as HTMLElement).focus()
		;(el as HTMLElement).innerText = text
		dispatchInputEvents(el)
		return `✅ Input "${text}" into element ${target.index}`
	}
	throw new ActionError(`Element ${target.index} is not editable (${target.tagName})`)
}

export function selectOption(target: IndexedElement, optionText: string): string {
	const el = target.element
	const view = el.ownerDocument?.defaultView
	if (!(el instanceof (view?.HTMLSelectElement ?? Object))) {
		throw new ActionError(`Element ${target.index} is not a <select> (${target.tagName})`)
	}
	const select = el as HTMLSelectElement
	const option = Array.from(select.options).find(
		(o) => o.text.trim().toLowerCase() === optionText.trim().toLowerCase()
	)
	if (!option) {
		const available = Array.from(select.options)
			.map((o) => o.text.trim())
			.join(', ')
		throw new ActionError(
			`Option "${optionText}" not found in element ${target.index}. Available: ${available}`
		)
	}
	highlight(select)
	select.value = option.value
	dispatchInputEvents(select)
	return `✅ Selected option "${option.text.trim()}" in element ${target.index}`
}

export type ScrollDirection = 'down' | 'up' | 'left' | 'right'

export function scrollPage(direction: ScrollDirection, target?: IndexedElement): string {
	const view = (target?.element.ownerDocument ?? document).defaultView ?? window
	const amount = Math.round((view.innerHeight || 600) * 0.9)
	const el = target?.element
	const scrollableTarget =
		el && (el.scrollHeight > el.clientHeight + 4 || el.scrollWidth > el.clientWidth + 4)
			? el
			: null

	const by: [number, number] =
		direction === 'down'
			? [0, amount]
			: direction === 'up'
				? [0, -amount]
				: direction === 'right'
					? [amount, 0]
					: [-amount, 0]

	if (scrollableTarget) {
		scrollableTarget.scrollBy({ left: by[0], top: by[1], behavior: 'instant' as ScrollBehavior })
		return `✅ Scrolled ${direction} inside element ${target!.index}`
	}
	view.scrollBy({ left: by[0], top: by[1], behavior: 'instant' as ScrollBehavior })
	return `✅ Scrolled ${direction} by ${amount}px`
}

export function getElement(snapshot: PageSnapshot, index: number): IndexedElement {
	const el = snapshot.elements[index]
	if (!el) {
		throw new ActionError(`Element ${index} not found (${snapshot.elements.length} available)`)
	}
	return el
}
