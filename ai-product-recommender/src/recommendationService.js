export async function getProducts() {
  const response = await fetch('/api/products')

  if (!response.ok) {
    throw new Error('Failed to load products from the backend.')
  }

  const payload = await response.json()
  return Array.isArray(payload.products) ? payload.products : []
}

export async function getRecommendations(preference) {
  const response = await fetch('/api/recommendations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ preference }),
  })

  if (!response.ok) {
    const errorMessage = await response.text()
    throw new Error(errorMessage || 'Failed to fetch recommendations from the backend.')
  }

  return response.json()
}
