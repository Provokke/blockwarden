'use client'

import { ConnectButton } from '../components/ConnectButton'
import { SignIn } from '../components/SignIn'
import { SignOut } from '../components/SignOut'
import { useSession } from '../lib/session'

export default function Home() {
  const { state, refresh } = useSession()
  return (
    <main>
      <h1>Blockwarden</h1>
      {state === 'loading' ? <p>Checking your session...</p> : null}
      {state === 'error' ? (
        <p role="alert">
          The API did not answer. <button onClick={refresh}>Retry</button>
        </p>
      ) : null}
      {state === 'signedOut' ? (
        <>
          <ConnectButton />
          <SignIn onSignedIn={refresh} />
        </>
      ) : null}
      {state === 'signedIn' ? (
        <>
          <p>Signed in.</p>
          <SignOut onSignedOut={refresh} />
        </>
      ) : null}
    </main>
  )
}
