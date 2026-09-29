// Shared Jev client factory (Review 02 P0-2). One rule for sim + play:
//   JEV_CLIENT=http|mock. Default: http when TYPESAFE_API_KEY is set, else mock.
// Mock mode prints a loud banner so nobody mistakes stub probabilities for judgments.
import { HttpJevClient, MockJevClient, type JevClient, type JevRequest } from "./JevClient.js";

export interface JevFactoryResult {
  client: JevClient;
  live: boolean;
  banner: string;
}

export function createJevClient(opts: {
  mockOverrides?: ConstructorParameters<typeof MockJevClient>[0];
  mockModel?: string;
  dynamicNoul?: (req: JevRequest, key: string) => number | undefined;
} = {}): JevFactoryResult {
  const setting = (process.env.JEV_CLIENT ?? "").toLowerCase();
  const hasKey = Boolean(process.env.TYPESAFE_API_KEY);
  const live = setting === "http" || (setting === "" && hasKey);
  if (live) {
    if (!hasKey) throw new Error("JEV_CLIENT=http but TYPESAFE_API_KEY is not set");
    const model = process.env.JEV_MODEL ?? "jev-latest";
    return { client: new HttpJevClient(), live: true, banner: `Jev: LIVE (${model})` };
  }
  return {
    client: new MockJevClient(opts.mockOverrides ?? {}, opts.mockModel ?? "jev-mock-0.1", opts.dynamicNoul),
    live: false,
    banner: "Jev: MOCK — judgments are stub probabilities, not real calls",
  };
}
