import { createApiServer } from "../../apps/api/src/server.js";

import { redact } from "./secrets.js";

export interface OwnerSignUpInput {
  readonly email: string;
  readonly password: string;
  readonly name: string;
}

export async function signUpBootstrapOwner(input: OwnerSignUpInput): Promise<{ userId: string }> {
  const server = createApiServer({ logger: false });
  try {
    await server.ready();
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json" },
      payload: { email: input.email, password: input.password, name: input.name }
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `Bootstrap owner sign-up failed with status ${response.statusCode}: ` +
          redact(response.body, [input.password])
      );
    }

    const body = response.json<{ user: { id: string } }>();
    return { userId: body.user.id };
  } finally {
    await server.close();
  }
}
