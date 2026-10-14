/** The "Tell us how it works" link on the newly enabled provider cards. Pure, so the core suite can check it. */

const FORM_URL = 'https://github.com/dnh33/legion/issues/new';

/** The cards that are new, and the name each has in the form's provider list (the form matches these words exactly). */
export const REPORT_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  openai: 'OpenAI', ollama: 'Ollama', lmstudio: 'LM Studio', vllm: 'vLLM',
};

/**
 * The address of the provider report form with the provider and the Legion version filled in. Nothing else goes in the address:
 * no key, no model name, no text a model wrote. A card that is not new has no link.
 */
export function providerReportUrl(providerId: string, version: string): string | undefined {
  const provider = REPORT_PROVIDER_LABELS[providerId];
  if (!provider) return undefined;
  const q = new URLSearchParams({ template: 'provider_report.yml', provider });
  const v = version.trim().slice(0, 40);
  if (v) q.set('version', v);
  return `${FORM_URL}?${q.toString()}`;
}

export function feedbackFor(providerId: string, version: string): { label: string; url: string } | undefined {
  const url = providerReportUrl(providerId, version);
  return url ? { label: 'New. Tell us how it works', url } : undefined;
}
