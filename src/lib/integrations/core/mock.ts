/**
 * Shared behaviour for MOCK providers. A mock is a real adapter behind the same interface
 * whose `scenario` decides what the "remote system" does — so the whole platform can be
 * demonstrated and tested without a customer credential. Mocks are labelled everywhere and
 * refused as a production provider unless INTEGRATIONS_ALLOW_MOCK=true.
 */
import { AuthenticationError, ProviderUnavailableError, RateLimitError, TimeoutError, ValidationError } from "./errors";

export const MOCK_SCENARIOS = ["ok", "empty", "auth-failure", "timeout", "rate-limit", "unavailable", "partial", "malformed", "duplicate"] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

export function parseScenario(v: unknown): MockScenario {
  return (MOCK_SCENARIOS as readonly string[]).includes(String(v)) ? (v as MockScenario) : "ok";
}

/** Throw the failure a scenario stands for (nothing for ok / empty / partial / duplicate / malformed — those shape the data). */
export function scenarioGate(scenario: MockScenario, provider: string): void {
  switch (scenario) {
    case "auth-failure": throw new AuthenticationError(`${provider} (mock) rejected the credentials (401)`);
    case "timeout": throw new TimeoutError(`${provider} (mock) did not answer in time`);
    case "rate-limit": throw new RateLimitError(`${provider} (mock) is rate limiting (429)`, 1000);
    case "unavailable": throw new ProviderUnavailableError(`${provider} (mock) is unavailable (503)`);
    default: return;
  }
}

export function malformed(provider: string): never { throw new ValidationError(`${provider} (mock) answered with malformed JSON`, { retryable: false }); }

export function mockAllowed(): boolean { return process.env.NODE_ENV !== "production" || process.env.INTEGRATIONS_ALLOW_MOCK === "true"; }
