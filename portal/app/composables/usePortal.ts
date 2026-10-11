export function usePortal() {
  const toast = useToast()
  const busy = ref(false)
  const error = ref('')
  async function action<T>(work: () => Promise<T>, success?: string): Promise<T | undefined> {
    busy.value = true
    error.value = ''
    try {
      const result = await work()
      if (success) toast.add({ title: success, color: 'success' })
      return result
    } catch (e: any) {
      const fallback = e?.name === 'FetchError' && !e.response ? 'Could not connect to Sipper. Check your connection and try again.' : 'This request could not be completed.'
      error.value = (typeof e?.data?.message === 'string' && e.data.message.trim()) || (e?.name !== 'FetchError' && typeof e?.message === 'string' && e.message.trim()) || fallback
      toast.add({ title: error.value, color: 'error' })
      return undefined
    } finally { busy.value = false }
  }
  return { busy, error, action }
}
