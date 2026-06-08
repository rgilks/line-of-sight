type NavigatorWithGpu = Navigator & {
  gpu?: {
    requestAdapter: () => Promise<unknown>
  }
}

export const detectWebGpu = async (): Promise<string> => {
  const gpu = (navigator as NavigatorWithGpu).gpu
  if (!gpu) return 'Unavailable'

  try {
    const adapter = await gpu.requestAdapter()
    return adapter ? 'Ready' : 'No adapter'
  } catch {
    return 'Blocked'
  }
}
