import { useCallback, useEffect, useRef, useState } from "react"
import type { Result } from "@launchkit/utils"
import type { IpcError } from "@launchkit/ipc"

/** The uniform shape every data hook returns. */
export type AsyncResource<T> = {
  readonly data: T | undefined
  readonly loading: boolean
  readonly error: IpcError | undefined
  readonly refetch: () => void
}

/**
 * Run an injected, `Result`-returning IPC call on mount and on `refetch`,
 * tracking loading/data/error. A mounted-ref guards against setting state after
 * unmount; a request counter discards stale responses when calls overlap.
 */
export const useAsyncResource = <T>(
  call: () => Promise<Result<T, IpcError>>,
): AsyncResource<T> => {
  const [data, setData] = useState<T | undefined>(undefined)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<IpcError | undefined>(undefined)

  const mounted = useRef<boolean>(true)
  const requestId = useRef<number>(0)

  const run = useCallback((): void => {
    const id = ++requestId.current
    setLoading(true)
    void call().then((result) => {
      if (!mounted.current || id !== requestId.current) return
      if (result.ok) {
        setData(result.value)
        setError(undefined)
      } else {
        setError(result.error)
      }
      setLoading(false)
    })
  }, [call])

  useEffect(() => {
    mounted.current = true
    run()
    return () => {
      mounted.current = false
    }
  }, [run])

  return { data, loading, error, refetch: run }
}
