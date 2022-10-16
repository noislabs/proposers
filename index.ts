import { fromBase64, toHex } from "@cosmjs/encoding";
import { anyToSinglePubkey } from "@cosmjs/proto-signing";
import { QueryClient, setupStakingExtension } from "@cosmjs/stargate";
import { pubkeyToAddress, Tendermint34Client } from "@cosmjs/tendermint-rpc";
import { assert } from "@cosmjs/utils";

assert(process.env.ENDPOINT, "ENDPOINT must be set");
const endpoint = process.env.ENDPOINT;

const client = await Tendermint34Client.connect(endpoint);
const chainHeight = (await client.status()).syncInfo.latestBlockHeight;

/** Map from proposer address to number of proposed blocks */
const proposedBlocks = new Map<string, number>();

// Top is the value after than the next request's maximum
let top = chainHeight + 1;
let headersCount = 0;

// CSV header
console.log("height,proposer,num_txs,gas_used,gas_wanted");

const pages = 10; // Every page to the /blockchain API gives us 20 results
for (let i = 0; i < pages; i++) {
  const headers = await client.blockchain(0, top - 1);
  for (let header of headers.blockMetas) {
    const height = header.header.height;
    const proposer = toHex(header.header.proposerAddress).toUpperCase();
    const count = (proposedBlocks.get(proposer) ?? 0) + 1;
    proposedBlocks.set(proposer, count);

    const resultsResult = await client.blockResults(height);
    // See https://github.com/tendermint/tendermint/issues/9555
    const [gasUsed, gasWanted] = resultsResult.results.reduce((acc, current) => {
      return [acc[0] + current.gasUsed, acc[1] + current.gasWanted];
    }, [0, 0]);

    // CSV format height,proposer,num_txs,gas_used,gas_wanted
    console.log(`${height},${proposer},${header.numTxs},${gasUsed},${gasWanted}`);
    top = Math.min(top, height);
    headersCount += 1;
  }
}

const queryClient = QueryClient.withExtensions(client, setupStakingExtension);

const tendermintToOperator = new Map<string, string>();
let nextKey: Uint8Array | undefined;
do {
  console.log(`Load validators page ...`);
  const res = await queryClient.staking.validators("BOND_STATUS_BONDED", nextKey);
  res.validators.forEach((r) => {
    assert(r.consensusPubkey);
    const pubkey = anyToSinglePubkey(r.consensusPubkey);
    const address = pubkeyToAddress("ed25519", fromBase64(pubkey.value));
    tendermintToOperator.set(address, r.operatorAddress);
  })
  nextKey = res.pagination?.nextKey;
} while (nextKey?.length)

console.log(`Total blocks scanned: ${headersCount} (from ${chainHeight} to ${top})`);

const res = await client.validatorsAll(chainHeight);

for (const val of res.validators) {
  const address = toHex(val.address).toUpperCase();
  console.log(`${address},${val.votingPower},${tendermintToOperator.get(address) ?? "?"},${proposedBlocks.get(address) ?? 0}`);
}
