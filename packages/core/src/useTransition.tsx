import React, { useEffect, useRef, useImperativeHandle, ReactNode } from 'react'
import { is, toArray, useForceUpdate, useOnce } from 'shared'
import { callProp, interpolateTo } from './helpers'
import { Controller } from './Controller'
import { now } from 'shared/globals'

export function useTransition<T>(
  data: T | readonly T[],
  props: any,
  deps?: any
) {
  const { ref, reset } = props
  const { transitions, changes } = useDiff(data, props)

  useEffect(
    () => {
      changes.forEach(({ phase, payload }, t) => {
        t.phase = phase
        if (payload) t.spring.update(payload)
        if (!ref) t.spring.start()
      })
    },
    reset ? void 0 : deps
  )

  const render = (render: (props: any, item: T) => ReactNode) =>
    transitions.map(t => {
      const elem: any = render({ ...t.spring.animated }, t.item)
      return elem && elem.type ? (
        <elem.type {...elem.props} key={t.id} ref={elem.ref} />
      ) : (
        elem
      )
    })

  return render
}

interface State<T = any> {
  transitions: Transition<T>[]
  changes: Map<Transition<T>, Change>
}

interface Change {
  phase: Phase
  payload?: any
}

interface Transition<T = any> {
  id: number
  item: T
  phase: Phase
  spring: Controller
  /** Destroy no later than this date */
  expiresBy?: number
  expirationId?: number
}

const enum Phase {
  /** This transition is being mounted */
  Mount,
  /** This transition is entering or has entered */
  Enter,
  /** This transition had its animations updated */
  Update,
  /** This transition will expire after animating */
  Leave,
}

function useDiff<T>(data: T | readonly T[], props: any): State {
  const { reset, trail = 0, expires = Infinity } = props

  // Every item has its own transition.
  const items = toArray(data)
  const transitions: Transition[] = []

  // The "onRest" callbacks need a ref to the latest transitions.
  const usedTransitions = useRef<Transition[] | null>(null)
  const prevTransitions = usedTransitions.current
  useEffect(() => {
    usedTransitions.current = transitions
  })

  // Destroy all transitions on dismount.
  useOnce(() => () => {
    usedTransitions.current!.forEach(t => t.spring.destroy())
  })

  // All items are new on first render.
  let newItems = items

  // Track the first render for the "initial" prop.
  const isFirst = reset || !prevTransitions
  if (!isFirst) {
    // Reuse old transitions unless expired.
    prevTransitions!.forEach(t => {
      if (is.und(t.expiresBy)) {
        transitions.push(t)
      } else {
        clearTimeout(t.expirationId)
      }
    })

    // Deduce which items are new.
    const oldItems = transitions.map(t => t.item)
    newItems = newItems.filter(item => oldItems.indexOf(item) < 0)
  }

  // Append transitions for new items.
  newItems.forEach(item => {
    const spring = new Controller()
    transitions.push({ id: spring.id, item, phase: Phase.Mount, spring })
  })

  // Track cumulative delay for the "trail" prop.
  let delay = -trail

  // Expired transitions use this to dismount.
  const forceUpdate = useForceUpdate()

  // Generate changes to apply in useEffect.
  const changes = new Map<Transition<T>, Change>()
  transitions.forEach((t, i) => {
    let to: any
    let phase: Phase
    if (t.phase == Phase.Mount) {
      to = (isFirst && props.initial) || props.enter
      phase = Phase.Enter
    } else {
      const isDeleted = items.indexOf(t.item) < 0
      if (t.phase < Phase.Leave) {
        if (isDeleted) {
          to = props.leave
          phase = Phase.Leave
        } else if ((to = props.update)) {
          phase = Phase.Update
        } else return
      } else if (!isDeleted) {
        to = props.enter
        phase = Phase.Enter
      } else return
    }

    const payload: any = {
      // When "to" is a function, it can return (1) an array of "useSpring" props,
      // (2) an async function, or (3) an object with any "useSpring" props.
      to: to = callProp(to, t.item, i),
      from: phase < Phase.Update ? callProp(props.from, t.item, i) : void 0,
      delay: delay += trail,
      config: callProp(props.config, t.item, i),
      ...(is.obj(to) && interpolateTo(to)),
    }

    const { onRest } = payload
    payload.onRest = (values: any) => {
      if (is.fun(onRest)) {
        onRest(values)
      }
      if (t.phase == Phase.Leave) {
        t.expiresBy = now() + expires
        if (expires <= 0) {
          forceUpdate()
        } else {
          // Postpone dismounts while other controllers are active.
          const transitions = usedTransitions.current!
          if (transitions.every(t => t.spring.idle)) {
            forceUpdate()
          } else if (expires < Infinity) {
            t.expirationId = setTimeout(forceUpdate, expires)
          }
        }
      }
    }

    const change: Change = { phase }
    changes.set(t, change)

    // To ensure all Animated nodes exist during render,
    // the payload must be applied immediately for new items.
    if (t.phase > Phase.Mount) {
      change.payload = payload
    } else {
      t.spring.update(payload)
    }
  })

  useImperativeHandle(
    props.ref,
    () => ({
      get controllers() {
        return usedTransitions.current!.map(t => t.spring)
      },
      start: () =>
        Promise.all(
          usedTransitions.current!.map(
            t => new Promise(done => t.spring.start(done))
          )
        ),
      stop: (finished?: boolean) =>
        usedTransitions.current!.forEach(t => t.spring.stop(finished)),
    }),
    []
  )

  return {
    changes,
    transitions,
  }
}
