const baseUrl = process.env.MEMOAR_API_URL ?? "http://localhost:4000";
const apiUrl = `${baseUrl}/v1`;
const headers = {
  "content-type": "application/json",
  authorization: `Bearer ${process.env.MEMOAR_E2E_TOKEN ?? "memoar-development-token"}`
};

await expectOk(`${baseUrl}/health`);
const sessions = await expectJson(`${apiUrl}/sessions`, { headers });
const first = sessions.items?.[0];
if (!first?.id) throw new Error("E2E seed returned no session");

const search = await expectJson(`${apiUrl}/search?q=archive`, { headers });
if (!search.meta?.realizedMode) throw new Error("Search did not report realized mode");

const pack = await expectJson(`${apiUrl}/pack`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    query: "archive parser decision",
    maxTokens: 600,
    maxEvidence: 4,
    maxSessions: 3,
    maxExcerptChars: 1000,
    freshnessPolicy: "mixed"
  })
});
if (!pack.evidence?.length || !pack.tokenEstimate) throw new Error("Pack returned no cited evidence");

console.log(`e2e smoke ok: session ${first.id}, search ${search.meta.realizedMode}, ${pack.evidence.length} evidence items`);

async function expectOk(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  return response;
}

async function expectJson(url, init) {
  const response = await expectOk(url, init);
  return response.json();
}
