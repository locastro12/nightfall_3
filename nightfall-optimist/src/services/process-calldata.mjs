/**
Function to retreive calldata associated with a blockchain event.
This is used, rather than re-emmiting the calldata in the event because it's
much cheaper, although the offchain part is more complex.
*/
import config from 'config';
import Web3 from '../utils/web3.mjs';
import Transaction from '../classes/transaction.mjs';
import Block from '../classes/block.mjs';
import { decompressProof } from '../utils/curve-maths/curves.mjs';
import { waitForContract } from '../event-handlers/subscribe.mjs';
import { getBlocks } from './database.mjs';

const { PROPOSE_BLOCK_TYPES, SUBMIT_TRANSACTION_TYPES, STATE_CONTRACT_NAME } = config;

export async function getProposeBlockCalldata(eventData) {
  const web3 = Web3.connection();
  const { transactionHash } = eventData;
  const tx = await web3.eth.getTransaction(transactionHash);
  // Remove the '0x' and function signature to recove rhte abi bytecode
  const abiBytecode = `0x${tx.input.slice(10)}`;
  const decoded = web3.eth.abi.decodeParameters(PROPOSE_BLOCK_TYPES, abiBytecode);
  const blockData = decoded['0'];
  const transactionsData = decoded['1'];
  const [leafCount, nCommitments, proposer, root] = blockData;
  const block = {
    proposer,
    root,
    leafCount: Number(leafCount),
    nCommitments: Number(nCommitments),
  };
  const transactions = transactionsData.map(t => {
    const [
      value,
      historicRootBlockNumberL2,
      transactionType,
      publicInputHash,
      tokenId,
      ercAddress,
      recipientAddress,
      commitments,
      nullifiers,
      proof,
    ] = t;
    const transaction = {
      value,
      historicRootBlockNumberL2,
      transactionType,
      publicInputHash,
      tokenId,
      ercAddress,
      recipientAddress,
      commitments,
      nullifiers,
      proof: decompressProof(proof),
    };
    transaction.transactionHash = Transaction.calcHash(transaction);
    // note, this transaction is incomplete in that the 'fee' field is empty.
    // that shouldn't matter as it's not needed.
    return transaction;
  });
  // Let's add in data that isn't directly available from the calldata but that
  // we know how to compute. Many node functions assume these are present.
  block.blockHash = Block.calcHash(block, transactions);
  // This line grabs the blockData array and extracts the index of the block
  // that we are dealing with.  TODO - this may get unmanageable with large
  // numbers of L2 blocks. Then we'll need to store it in a DB and sync to the

  // This gets all blocks that we have stored locally - could be improved by pre-filtering here
  const storedBlocks = await getBlocks();
  const storedL2BlockNumbers = storedBlocks.map(s => s.blockNumberL2);
  // This is a kinda cool way to check for gaps since blockhashes is also zero-indexed!
  const L2BlockNumbersSequenced = storedL2BlockNumbers.filter((num, index) => num - index === 0); // This is the array of numbers that are in order.
  // This is the last block number that is in sequence order, otherwise set it as -1
  const lastReliableL2BlockNumber =
    L2BlockNumbersSequenced[L2BlockNumbersSequenced.length - 1] || -1;

  const stateContractInstance = await waitForContract(STATE_CONTRACT_NAME);
  let counter = lastReliableL2BlockNumber;
  let onChainBlockData;
  do {
    counter++;
    try {
      // eslint-disable-next-line no-await-in-loop
      onChainBlockData = await stateContractInstance.methods.blockHashes(counter).call();
    } catch (error) {
      throw new Error('Could not find blockHash in blockchain record');
      // break;
    }
  } while (onChainBlockData.blockHash !== block.blockHash);
  // counter now has the new blockNumberL2
  block.blockNumberL2 = counter;

  block.transactionHashes = transactions.map(t => t.transactionHash);
  // currentLeafCount holds the count of the next leaf to be added
  const currentLeafCount = Number(nCommitments) + Number(leafCount);
  return { block, transactions, currentLeafCount };
}

export async function getTransactionSubmittedCalldata(eventData) {
  const web3 = Web3.connection();
  const { transactionHash } = eventData;
  const tx = await web3.eth.getTransaction(transactionHash);
  // Remove the '0x' and function signature to recove rhte abi bytecode
  const abiBytecode = `0x${tx.input.slice(10)}`;
  const transactionData = web3.eth.abi.decodeParameter(SUBMIT_TRANSACTION_TYPES, abiBytecode);
  const [
    value,
    historicRootBlockNumberL2,
    transactionType,
    publicInputHash,
    tokenId,
    ercAddress,
    recipientAddress,
    commitments,
    nullifiers,
    proof,
  ] = transactionData;
  const transaction = {
    fee: Number(tx.value),
    value,
    historicRootBlockNumberL2,
    transactionType,
    publicInputHash,
    tokenId,
    ercAddress,
    recipientAddress,
    commitments,
    nullifiers,
    proof: decompressProof(proof),
  };
  transaction.transactionHash = Transaction.calcHash(transaction);
  return transaction;
}
