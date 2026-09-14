/**
 * openFDA Device UDI endpoint — a searchable mirror of AccessGUDID.
 * Docs: https://open.fda.gov/apis/device/udi/
 *
 * Unlike accessgudid.nlm.nih.gov (which only looks up by Device Identifier),
 * openFDA lets us search by catalog_number / version_or_model_number, which
 * is what a sales rep actually has. Every hit is the full GUDID record.
 */

const BASE = "https://api.fda.gov/device/udi.json";

export type OpenFdaRecord = {
  public_device_record_key?: string;
  brand_name?: string;
  company_name?: string;
  catalog_number?: string;
  version_or_model_number?: string;
  device_description?: string;
  commercial_distribution_status?: string;
  record_status?: string;
  is_single_use?: string;
  is_kit?: string;
  is_rx?: string;
  device_count_in_base_package?: string;
  identifiers?: { id: string; type: string; issuing_agency?: string }[];
  product_codes?: { code: string; name: string; openfda?: { device_name?: string; medical_specialty_description?: string; device_class?: string } }[];
  gmdn_terms?: { code: string; name: string; definition?: string; implantable?: string }[];
  device_sizes?: { type?: string; value?: string; unit?: string; text?: string }[];
  sterilization?: { is_sterile?: string; is_sterilization_prior_use?: string };
  premarket_submissions?: { submission_number: string }[];
  publish_date?: string;
  public_version_date?: string;
};

export type OpenFdaSearch = { total: number; results: OpenFdaRecord[] };

function q(s: string) {
  // openFDA phrase search: quote and escape internal quotes
  return `"${s.replace(/"/g, '\\"')}"`;
}

async function fetchJson(url: string, retries = 2): Promise<OpenFdaSearch | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
    if (res.status === 404) return { total: 0, results: [] }; // openFDA uses 404 for "no matches"
    if (res.status === 429 && attempt < retries) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`openFDA ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return { total: data?.meta?.results?.total ?? data?.results?.length ?? 0, results: data?.results ?? [] };
  }
  return null;
}

export async function searchOpenFda(search: string, limit = 10): Promise<OpenFdaSearch> {
  // NB: openFDA's query grammar uses literal "+" as the token separator
  // ("a+OR+b"), so we must not run the whole string through URLSearchParams.
  const encoded = search.replace(/"([^"]*)"/g, (_m, inner: string) => `"${encodeURIComponent(inner)}"`).replace(/ /g, "+");
  let url = `${BASE}?search=${encoded}&limit=${limit}`;
  if (process.env.OPENFDA_API_KEY) url += `&api_key=${encodeURIComponent(process.env.OPENFDA_API_KEY)}`;
  const data = await fetchJson(url);
  return data ?? { total: 0, results: [] };
}

/** Search by catalog number OR version/model number (the two places a CFN lives in GUDID). */
export async function searchByCfn(cfn: string, limit = 10): Promise<OpenFdaSearch> {
  return searchOpenFda(`catalog_number:${q(cfn)}+OR+version_or_model_number:${q(cfn)}`, limit);
}

export async function searchByBrandAndCompany(brand: string, company?: string, limit = 10): Promise<OpenFdaSearch> {
  const parts = [`brand_name:${q(brand)}`];
  if (company) parts.push(`company_name:${q(company)}`);
  return searchOpenFda(parts.join("+AND+"), limit);
}

export async function lookupByDi(di: string): Promise<OpenFdaRecord | null> {
  const r = await searchOpenFda(`identifiers.id:${q(di)}`, 1);
  return r.results[0] ?? null;
}

/**
 * Rank hits for a CFN: prefer the original labeler over reprocessors
 * (Sterilmed, Stryker Sustainability, Provision…), records in commercial
 * distribution, and records whose CFN field equals the query exactly.
 */
export function rankHits(hits: OpenFdaRecord[], cfn: string, preferCompanies: string[] = []): OpenFdaRecord[] {
  const reprocessor = /sterilmed|sustainability|provision|reprocess|innovative health|medline renewal|northeast scientific|renu/i;
  const score = (r: OpenFdaRecord) => {
    let s = 0;
    const exact = (r.catalog_number ?? "").toUpperCase() === cfn || (r.version_or_model_number ?? "").toUpperCase() === cfn;
    if (exact) s += 4;
    if (!reprocessor.test(r.company_name ?? "")) s += 3;
    if ((r.commercial_distribution_status ?? "").startsWith("In Commercial")) s += 2;
    if (preferCompanies.some((c) => (r.company_name ?? "").toLowerCase().includes(c.toLowerCase()))) s += 2;
    if (r.device_description) s += 1;
    if ((r.device_sizes?.length ?? 0) > 0) s += 0.5;
    return s;
  };
  return [...hits].sort((a, b) => score(b) - score(a));
}

/** Flatten an openFDA record into the columns CRACR stores. */
export function summarizeRecord(r: OpenFdaRecord) {
  const gmdn = r.gmdn_terms?.[0];
  const pc = r.product_codes?.[0];
  const di = r.identifiers?.find((i) => i.type === "Primary")?.id ?? r.identifiers?.[0]?.id;
  const description = [r.brand_name, r.device_description].filter(Boolean).join(" — ").replace(/\s+/g, " ").trim();
  return {
    manufacturer: r.company_name ?? null,
    brand: r.brand_name ?? null,
    description: description || null,
    gudidDi: di ?? null,
    gmdnName: gmdn?.name ?? null,
    gmdnCode: gmdn?.code ?? null,
    fdaProductCode: pc?.code ?? null,
    status: r.commercial_distribution_status ?? null,
    sizes: r.device_sizes ?? [],
    singleUse: r.is_single_use === "true" ? true : r.is_single_use === "false" ? false : null,
    sterile: r.sterilization?.is_sterile === "true" ? true : r.sterilization?.is_sterile === "false" ? false : null,
    implantable: gmdn?.implantable === "true" ? true : gmdn?.implantable === "false" ? false : null,
  };
}

/** Normalise labeler names into a display-friendly competitor name. */
export function displayManufacturer(name?: string | null): string {
  if (!name) return "Unknown";
  const n = name.toLowerCase();
  if (n.includes("gore")) return "W.L. Gore";
  if (n.includes("ethicon") || n.includes("johnson")) return "Ethicon";
  if (n.includes("sterilmed")) return "Ethicon - SterilMed";
  if (n.includes("bard") || n.includes("becton") || n.includes("davol")) return "BD - Bard";
  if (n.includes("applied medical")) return "Applied Medical";
  if (n.includes("conmed")) return "Conmed";
  if (n.includes("teleflex")) return "Teleflex";
  if (n.includes("covidien") || n.includes("medtronic") || n.includes("sofradim")) return "Medtronic";
  if (n.includes("lexington")) return "Lexington Medical";
  if (n.includes("genicon")) return "Genicon";
  if (n.includes("stryker")) return "Stryker";
  if (n.includes("olympus")) return "Olympus";
  if (n.includes("intuitive")) return "Intuitive Surgical";
  if (n.includes("b. braun") || n.includes("b.braun") || n.includes("aesculap")) return "B. Braun / Aesculap";
  if (n.includes("cooper")) return "Cooper Surgical";
  return name.replace(/,?\s*(inc\.?|llc|l\.p\.|lp|corporation|corp\.?|ltd\.?|limited|gmbh|s\.a\.)\s*$/i, "").replace(/\s+/g, " ").trim()
    .split(" ").map((w) => (w.length > 3 && w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w)).join(" ");
}
