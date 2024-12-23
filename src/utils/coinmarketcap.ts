import { BotService } from "../bot";
import config from "./config";

export const getPrice = async (
  tokenAddress: string,
  botService: BotService
) => {
  try {
    const coinMarketCapApiKey = config.coinMarketCapApiKey;

    // First, get token info to find symbol
    const infoResponse = await fetch(
      `https://pro-api.coinmarketcap.com/v2/cryptocurrency/info?address=${tokenAddress}`,
      {
        headers: {
          "X-CMC_PRO_API_KEY": coinMarketCapApiKey,
        },
      }
    );

    const infoData = await infoResponse.json();

    // Get the first token from the response (assuming unique address)
    const tokenInfo = Object.values(infoData.data)[0] as {
      symbol: string;
    };
    const symbol = tokenInfo.symbol;

    // Then get the price using the symbol
    const priceResponse = await fetch(
      `https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?symbol=${symbol}`,
      {
        headers: {
          "X-CMC_PRO_API_KEY": coinMarketCapApiKey,
        },
      }
    );

    const priceData = await priceResponse.json();
    const tokenData = priceData.data[symbol];

    if (!tokenData || tokenData.length === 0) {
      throw new Error(`Token ${symbol} not found in CoinMarketCap data`);
    }

    const usdPrice = tokenData[0].quote.USD.price;
    return usdPrice;
  } catch (error) {
    await botService.sendError(
      `Error fetching price for token address ${tokenAddress}: ${error}`
    );
    return 0;
  }
};
