'use client'

import { useRef, useState } from 'react'
import { ApiError, apiFetch } from '../lib/api'

type Outcome = { kind: 'idle' } | { kind: 'sent' } | { kind: 'refused'; message: string }

export type Settled = { kind: 'sent' } | { kind: 'refused'; message: string }

// `deliveryRef` is the opaque ref the listing gave this row; the API reads the row's address out of it and
// refuses one that belongs to another delivery
export function RedriveButton({
  deliveryId,
  deliveryRef,
  onChanged,
  onSettled,
}: {
  deliveryId: string
  deliveryRef: string
  onChanged: () => void
  // a reload can remove this row and this component with it, so the page keeps the outcome where it survives
  onSettled?: (settled: Settled) => void
}) {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' })
  const inFlight = useRef(false)

  async function redrive() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setOutcome({ kind: 'idle' })
    try {
      await apiFetch(`/v1/deliveries/${encodeURIComponent(deliveryId)}/redrive`, {
        method: 'POST',
        body: { ref: deliveryRef },
      })
      setOutcome({ kind: 'sent' })
      onSettled?.({ kind: 'sent' })
      onChanged()
    } catch (err) {
      if (err instanceof ApiError) {
        setOutcome({ kind: 'refused', message: err.message })
        onSettled?.({ kind: 'refused', message: err.message })
        // 409 means the listing is out of date (it was redriven or sent meanwhile), not that the click was
        // wrong. Any other refusal changed nothing, and reloading would only hide its message.
        if (err.status === 409) onChanged()
      } else {
        console.error('redrive failed', err)
        setOutcome({ kind: 'refused', message: 'Could not reach the API.' })
        onSettled?.({ kind: 'refused', message: 'Could not reach the API.' })
      }
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <span>
      <button type="button" onClick={redrive} disabled={busy}>
        Redrive
      </button>
      {outcome.kind === 'sent' ? (
        <span role="status" className="note">
          Queued again
        </span>
      ) : null}
      {outcome.kind === 'refused' ? (
        <span role="alert" className="note">
          {outcome.message}
        </span>
      ) : null}
    </span>
  )
}
