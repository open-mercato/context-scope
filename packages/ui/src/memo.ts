/**
 * Minimal `memo` without pulling in preact/compat: a class wrapper whose
 * shouldComponentUpdate is a shallow props comparison. Hooks inside the wrapped
 * function component keep working because it is rendered as its own element.
 */
import { Component, h, type ComponentType, type VNode } from "preact";

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (a === b) return true;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

export function memo<P extends object>(Wrapped: ComponentType<P>): ComponentType<P> {
  class Memo extends Component<P> {
    static displayName = `memo(${Wrapped.displayName ?? Wrapped.name ?? "Component"})`;
    shouldComponentUpdate(next: P) { return !shallowEqual(this.props as Record<string, unknown>, next as Record<string, unknown>); }
    render(props: P): VNode { return h(Wrapped as ComponentType<P>, props) as unknown as VNode; }
  }
  return Memo as unknown as ComponentType<P>;
}
