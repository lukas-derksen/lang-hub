// What the tests replace (test/routes.test.ts): the Claude client. Production uses the real SDK.
import Anthropic from '@anthropic-ai/sdk';

export const deps = {
  claude: (apiKey: string): Anthropic => new Anthropic({ apiKey }),
};
