export function peopleBridge(client) {
  return {
    client,
    api: {
      async request(method, path, body) {
        const response = await client.request(method, path, JSON.parse(body));
        return JSON.stringify(response);
      },
      chat: (text) => client.chat(text)
    }
  };
}
