import {
  TrailsClient,
  buildSwapRequest,
  validateSwapQuote,
} from '@polygonlabs/oms-server-wallet-sdk/trails';

// Explicit live opt-in. Discovery/quotes only; never executes, signs or funds an intent.
const client = new TrailsClient({
  apiKey: process.env.TRAILS_API_KEY ?? '',
  baseUrl: process.env.TRAILS_API_URL,
  origin: process.env.APP_ORIGIN,
});
try {
  const { TrailsContracts } = await client.readiness();
  const chainIds = [1, 137, 42161, 8453, 56];
  const { chains } = await client.getChains();
  const { tokens } = await client.getTokenList(chainIds);
  console.log(
    JSON.stringify({
      protocol: 'v1.5',
      chains: chains.filter((c) => chainIds.includes(c.id)).map((c) => c.id),
      tokens: tokens.length,
    }),
  );
  if (process.env.TRAILS_TEST_WALLET) {
    const assets = [
      { chainId: 137, asset: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6 },
      { chainId: 8453, asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
      { chainId: 137, asset: 'native', decimals: 18 },
    ];
    for (const input of [
      {
        originChainId: 137,
        originAsset: assets[0].asset,
        destinationChainId: 8453,
        destinationAsset: assets[1].asset,
        amount: '10000000',
      },
      {
        originChainId: 137,
        originAsset: 'native',
        destinationChainId: 137,
        destinationAsset: assets[0].asset,
        amount: '100000000000000000000',
      },
    ]) {
      const request = buildSwapRequest(process.env.TRAILS_TEST_WALLET, input, assets);
      const { intent } = await client.quoteIntent(request);
      const quote = await validateSwapQuote(intent, request, TrailsContracts);
      console.log(
        JSON.stringify({
          validated: true,
          originChainId: input.originChainId,
          destinationChainId: input.destinationChainId,
          originAsset: input.originAsset,
          inputAmount: quote.funding.amount,
          minimumOutput: intent.quote.toAmountMin,
          expiresAt: intent.expiresAt,
        }),
      );
    }
    const { tokens: routes } = await client.getExactInputRoutes(137, assets[0].asset);
    console.log(JSON.stringify({ exactInputDestinationTokens: routes.length }));
  }
} catch (error) {
  // Avoid logging fetch causes/response bodies, which can include credentials.
  console.error(
    JSON.stringify({
      failed: true,
      code: error && typeof error === 'object' && 'code' in error ? error.code : 'CHECK_FAILED',
    }),
  );
  process.exitCode = 1;
}
