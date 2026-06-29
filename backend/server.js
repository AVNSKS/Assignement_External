import http from 'node:http'
import dotenv from 'dotenv'
import products from './products.js'

dotenv.config()

const port = Number.parseInt(process.env.PORT || '3001', 10)
const maxRecommendations = 6

let catalogProducts = [...products]
let nextProductId = 100

function normalizeText(value) {
  return value.toLowerCase().replace(/[^a-z0-9.\s$]/gi, ' ')
}

function parseBudget(preference) {
  const patterns = [
    /under\s*\$?\s*(\d+(?:\.\d+)?)/i,
    /below\s*\$?\s*(\d+(?:\.\d+)?)/i,
    /less than\s*\$?\s*(\d+(?:\.\d+)?)/i,
    /budget\s*(?:of)?\s*\$?\s*(\d+(?:\.\d+)?)/i,
  ]

  for (const pattern of patterns) {
    const match = preference.match(pattern)

    if (match) {
      return Number.parseFloat(match[1])
    }
  }

  return null
}

function scoreProduct(preference, product) {
  const preferenceText = normalizeText(preference)
  const haystack = normalizeText(`${product.name} ${product.category} ${product.description}`)
  let score = 0

  for (const keyword of preferenceText.split(/\s+/)) {
    if (!keyword || keyword.length < 3) {
      continue
    }

    if (haystack.includes(keyword)) {
      score += 12
    }
  }

  const budget = parseBudget(preference)

  if (budget !== null) {
    if (product.price <= budget) {
      const distance = budget - product.price
      score += 20 + Math.max(0, 18 - distance / 20)
    } else {
      score -= Math.min(20, (product.price - budget) / 15)
    }
  }

  if (/phone|mobile|smartphone/i.test(preference) && product.category === 'Electronics') {
    score += 18
  }

  if (/gift|present/i.test(preference)) {
    score += product.rating >= 4.4 ? 10 : 0
  }

  if (/home|decor|living room|lamp|table/i.test(preference) && product.category === 'Home Goods') {
    score += 18
  }

  if (/workout|fitness|gym|exercise|run/i.test(preference) && product.category === 'Fitness') {
    score += 20
  }

  if (/kitchen|cook|blend|food|recipe/i.test(preference) && product.category === 'Kitchen') {
    score += 20
  }

  score += product.rating * 3

  return score
}

function localRecommendations(preference, reason) {
  const rankedProducts = [...catalogProducts]
    .map((product) => ({
      product,
      score: scoreProduct(preference, product),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, maxRecommendations)
    .map(({ product }) => product)

  return {
    source: 'local',
    explanation:
      reason ||
      'Used local matching rules to rank products because the AI API was not available.',
    products: rankedProducts,
  }
}

function extractJsonObject(content) {
  const trimmedContent = content.trim()

  if (trimmedContent.startsWith('{')) {
    return trimmedContent
  }

  const fencedMatch = trimmedContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)

  if (fencedMatch) {
    return fencedMatch[1].trim()
  }

  const objectMatch = trimmedContent.match(/\{[\s\S]*\}/)

  return objectMatch ? objectMatch[0] : trimmedContent
}

function buildAiClient() {
  const apiKey = process.env.GEMINI_API_KEY

  if (!apiKey) {
    return null
  }

  return apiKey
}

function buildCatalog() {
  return products.map(({ id, name, category, price, description, rating }) => ({
    id,
    name,
    category,
    price,
    description,
    rating,
  }))
}

async function getRecommendations(preference) {
  const apiKey = buildAiClient()

  if (!apiKey) {
    return localRecommendations(preference)
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text:
                  'You are an intelligent product recommendation engine. Based on the user\'s shopping preference, generate exactly 5 or 6 high-quality, realistic recommended products that perfectly suit their needs. Return a JSON object with the keys "products" and "explanation". "products" must be an array of objects, where each object contains: "name" (a realistic product name), "category" (e.g., Electronics, Clothing, Home Goods, Kitchen, Fitness, Beauty, Books, Accessories), "price" (a realistic number), "description" (a detailed product description), and "rating" (a realistic rating number between 1.0 and 5.0). "explanation" must be a string explaining why these products are recommended.',
              },
            ],
          },
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: `Preference: ${preference}`,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: 'application/json',
          },
        }),
      },
    )

    if (!response.ok) {
      throw new Error(`Gemini request failed with status ${response.status}`)
    }

    const payload = await response.json()
    const content = payload?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || '')
      .join('')
      .trim()

    if (!content) {
      return localRecommendations(
        preference,
        'The AI response was empty, so the app used local scoring instead.',
      )
    }

    const parsedResponse = JSON.parse(extractJsonObject(content))
    const aiProducts = Array.isArray(parsedResponse.products) ? parsedResponse.products : []

    const orderedProducts = []
    for (const item of aiProducts) {
      if (!item.name || !item.price) {
        continue
      }

      const existing = catalogProducts.find(
        (p) => p.name.toLowerCase() === item.name.trim().toLowerCase(),
      )

      if (existing) {
        orderedProducts.push(existing)
      } else {
        const newProduct = {
          id: nextProductId++,
          name: item.name.trim(),
          category: item.category || 'General',
          price: Number.parseFloat(item.price) || 0,
          description: item.description || '',
          rating: Number.parseFloat(item.rating) || 4.0,
        }
        catalogProducts.push(newProduct)
        orderedProducts.push(newProduct)
      }
    }

    if (!orderedProducts.length) {
      return localRecommendations(
        preference,
        'The AI did not return valid products, so the app used local scoring instead.',
      )
    }

    return {
      source: 'ai',
      explanation:
        parsedResponse.explanation?.trim() ||
        'AI generated products based on your preference.',
      products: orderedProducts.slice(0, maxRecommendations),
    }
  } catch (error) {
    console.error('Gemini API Error:', error)
    return localRecommendations(
      preference,
      'AI request failed, so the app used local scoring instead.',
    )
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  response.end(JSON.stringify(payload))
}

const requestHandler = (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    response.end()
    return
  }

  console.log(`[REQUEST] Method: ${request.method}, URL: ${request.url}`)
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)

  if (request.method === 'GET' && requestUrl.pathname === '/health') {
    sendJson(response, 200, { ok: true })
    return
  }

  if (request.method === 'GET' && (requestUrl.pathname === '/api/products' || requestUrl.pathname === '/products')) {
    sendJson(response, 200, { products: catalogProducts })
    return
  }

  if (request.method === 'POST' && (requestUrl.pathname === '/api/recommendations' || requestUrl.pathname === '/recommendations')) {
    let requestBody = ''

    request.on('data', (chunk) => {
      requestBody += chunk
    })

    request.on('end', async () => {
      try {
        const parsedBody = requestBody ? JSON.parse(requestBody) : {}
        const preference = typeof parsedBody.preference === 'string' ? parsedBody.preference.trim() : ''

        if (!preference) {
          sendJson(response, 400, {
            error: 'Please provide a shopping preference.',
          })
          return
        }

        const recommendation = await getRecommendations(preference)
        sendJson(response, 200, recommendation)
      } catch (err) {
        console.error('Recommendations error:', err)
        sendJson(response, 500, {
          error: 'Unable to generate recommendations.',
        })
      }
    })

    return
  }

  sendJson(response, 404, { error: 'Not found' })
}

const server = http.createServer(requestHandler)

if (!process.env.VERCEL) {
  server.listen(port, () => {
    console.log(`Backend server running on http://localhost:${port}`)
  })
}

export default requestHandler
