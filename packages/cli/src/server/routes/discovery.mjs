/** Consent: the one public API route. `authorize` (server/app.mjs) flips the gate and kicks the index. */
export default function discoveryRoutes({ authorize }) {
  return [
    {
      method: "POST",
      pattern: "/api/authorize",
      public: true,
      async handler({ response }) {
        await authorize();
        response.writeHead(204, { "cache-control": "no-store", "referrer-policy": "no-referrer" });
        response.end();
      },
    },
  ];
}
