import * as https from 'https';

const OPENAI_API_URL = 'https://api.openai.com/v1/embeddings';
const MODEL = 'text-embedding-3-small';
const DIMENSIONS = 1536;

export async function getEmbedding(text: string, apiKey: string): Promise<Float32Array> {
  const body = JSON.stringify({ input: text, model: MODEL, dimensions: DIMENSIONS });

  return new Promise((resolve, reject) => {
    const req = https.request(
      OPENAI_API_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as {
              data: Array<{ embedding: number[] }>;
              error?: { message: string };
            };
            if (parsed.error) {
              reject(new Error(`OpenAI API error: ${parsed.error.message}`));
              return;
            }
            const embedding = new Float32Array(parsed.data[0].embedding);
            resolve(embedding);
          } catch (e) {
            reject(new Error(`Failed to parse OpenAI response: ${e}`));
          }
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export { DIMENSIONS };
