import axios from 'axios';
import Web3 from 'web3';
import WebSocket from 'ws';
import EventEmitter from 'events';
import { Mutex } from 'async-mutex';

/**
@class
Creates a new Nightfall_3 library instance.
@param {string} clientBaseUrl - The base url for nightfall-client
@param {string} optimistBaseUrl - The base url for nightfall-optimist
@param {string} optimistWsUrl - The webscocket url for nightfall-optimist
@param {string} web3WsUrl - The websocket url for the web3js client
@param {string} ethereumSigningKey - the Ethereum siging key to be used for transactions (hex string).
@param {object} zkpKeys - An object containing the zkp keys to use.  These will be auto-generated if left undefined.
*/
class Nf3 {
  clientBaseUrl;

  optimistBaseUrl;

  optimistWsUrl;

  web3WsUrl;

  web3;

  websockets = [];

  shieldContractAddress;

  proposersContractAddress;

  challengesContractAddress;

  stateContractAddress;

  ethereumSigningKey;

  ethereumAddress;

  zkpKeys;

  defaultFee = 10;

  PROPOSER_BOND = 10;

  BLOCK_STAKE = 1;

  nonce = 0;

  nonceMutex = new Mutex();

  latestWithdrawHash;

  constructor(
    clientBaseUrl,
    optimistBaseUrl,
    optimistWsUrl,
    web3WsUrl,
    ethereumSigningKey,
    zkpKeys,
  ) {
    this.clientBaseUrl = clientBaseUrl;
    this.optimistBaseUrl = optimistBaseUrl;
    this.optimistWsUrl = optimistWsUrl;
    this.web3WsUrl = web3WsUrl;
    this.ethereumSigningKey = ethereumSigningKey;
    this.zkpKeys = zkpKeys;
  }

  /**
  Initialises the Nf_3 object so that it can communicate with Nightfall_3 and the
  blockchain.
  @returns {Promise}
  */
  async init() {
    this.setWeb3Provider(this.web3WsUrl);
    this.zkpKeys = this.zkpKeys || (await axios.post(`${this.clientBaseUrl}/generate-keys`)).data;
    this.shieldContractAddress = await this.getContractAddress('Shield');
    this.proposersContractAddress = await this.getContractAddress('Proposers');
    this.challengesContractAddress = await this.getContractAddress('Challenges');
    this.stateContractAddress = await this.getContractAddress('State');
    // set the ethereumAddress iff we have a signing key
    if (typeof this.ethereumSigningKey === 'string') {
      this.ethereumAddress = this.getAccounts();
    }
    return this.subscribeToIncomingViewingKeys();
  }

  /**
  Setter for the ethereum private key, in case it wasn't known at build time.
  This will also update the corresponding Ethereum address that Nf_3 uses.
  @method
  @param {string} key - the ethereum private key as a hex string.
  */
  setEthereumSigningKey(key) {
    this.ethereumSigningKey = key;
    this.ethereumAddress = this.getAccounts();
    // clear the nonce as we're using a fresh account
    this.nonce = 0;
  }

  /**
  Setter for the zkp keys, in case it wasn't known at build time and we don't
  want to use autogenerated ones.
  @method
  @param {object} keys - The zkp keys object.
  */
  setzkpKeys(keys) {
    this.zkpKeys = keys;
  }

  /**
  Method for signing and submitting an Ethereum transaction to the
  blockchain.
  @method
  @async
  @param {object} unsignedTransaction - An unsigned web3js transaction object.
  @param {string} shieldContractAddress - The address of the Nightfall_3 shield address.
  @param {number} fee - the value of the transaction.
  This can be found using the getContractAddress convenience function.
  @returns {Promise} This will resolve into a transaction receipt.
  */
  async submitTransaction(
    unsignedTransaction,
    contractAddress = this.shieldContractAddress,
    fee = this.defaultFee,
  ) {
    // We'll manage the nonce ourselves because we can run too fast for the blockchain client to update
    // we need a Mutex so that we don't get a nonce-updating race.
	  
    let tx;
    await this.nonceMutex.runExclusive(async () => {
      // if we don't have a nonce, we must get one from the ethereum client
      if (!this.nonce) {
         console.log("NONCE", this.nonce, this.ethereumAddress);
	 this.nonce = await this.web3.eth.getTransactionCount(this.ethereumAddress);
         console.log("NONCE", this.nonce, this.ethereumAddress, await this.web3.eth.getTransactionCount(this.ethereumAddress)) ;
      }
      tx = {
        from: this.ethereumAddress,
        to: contractAddress,
        data: unsignedTransaction,
        value: fee,
        gas: 10000000,
        gasPrice: 10000000000,
        nonce: this.nonce,
      };
      this.nonce++;
    });

    if (this.ethereumSigningKey) {
      const signed = await this.web3.eth.accounts.signTransaction(tx, this.ethereumSigningKey);
      return this.web3.eth.sendSignedTransaction(signed.rawTransaction);
    }
    return this.web3.eth.sendTransaction(tx);
  }

  /**
  Determines if a Nightfall_3 server is running and healthy.
  @method
  @async
  @param {string} server - The name of the server being checked ['client', 'optimist']
  @returns {Promise} This will resolve into a boolean - true if the healthcheck passed.
  */
  async healthcheck(server) {
    let url;
    switch (server) {
      case 'client':
        url = this.clientBaseUrl;
        break;
      case 'optimist':
        url = this.optimistBaseUrl;
        break;
      default:
        throw new Error('Unknown server name');
    }
    let res;
    try {
      res = await axios.get(`${url}/healthcheck`);
      if (res.status !== 200) return false;
    } catch (err) {
      return false;
    }
    return true;
  }

  /**
  Returns the address of a Nightfall_3 contract.
  @method
  @async
  @param {string} contractName - the name of the smart contract in question. Possible
  values are 'Shield', 'State', 'Proposers', 'Challengers'.
  @returns {Promise} Resolves into the Ethereum address of the contract
  */
  async getContractAddress(contractName) {
    const res = await axios.get(`${this.clientBaseUrl}/contract-address/${contractName}`);
    return res.data.address;
  }

  /**
  Deposits a Layer 1 token into Layer 2, so that it can be transacted
  privately.
  @method
  @async
  @param {number} fee - The amount (Wei) to pay a proposer for the transaction
  @param {string} ercAddress - The address of the ERCx contract from which the token
  is being taken.  Note that the Nightfall_3 State.sol contract must be approved
  by the token's owner to be able to withdraw the token.
  @param {string} tokenType - The type of token to deposit. Possible values are
  'ERC20', 'ERC721', 'ERC1155'.
  @param {number} value - The value of the token, in the case of an ERC20 or ERC1155
  token.  For ERC721 this should be set to zero.
  @param {string} tokenId - The ID of an ERC721 or ERC1155 token.  In the case of
  an 'ERC20' coin, this should be set to '0x00'.
  @param {object} keys - The ZKP private key set.
  @returns {Promise} Resolves into the Ethereum transaction receipt.
  */
  async deposit(ercAddress, tokenType, value, tokenId, fee = this.defaultFee) {
    const res = await axios.post(`${this.clientBaseUrl}/deposit`, {
      ercAddress,
      tokenId,
      tokenType,
      value,
      pkd: this.zkpKeys.pkd,
      nsk: this.zkpKeys.nsk,
      fee,
    });
    return this.submitTransaction(res.data.txDataToSign, this.shieldContractAddress, fee);
  }

  /**
  Transfers a token within Layer 2.
  @method
  @async
  @param {number} fee - The amount (Wei) to pay a proposer for the transaction
  @param {string} ercAddress - The address of the ERCx contract from which the token
  is being taken.  Note that the Nightfall_3 State.sol contract must be approved
  by the token's owner to be able to withdraw the token.
  @param {string} tokenType - The type of token to deposit. Possible values are
  'ERC20', 'ERC721', 'ERC1155'.
  @param {number} value - The value of the token, in the case of an ERC20 or ERC1155
  token.  For ERC721 this should be set to zero.
  @param {string} tokenId - The ID of an ERC721 or ERC1155 token.  In the case of
  an 'ERC20' coin, this should be set to '0x00'.
  @param {object} keys - The ZKP private key set of the sender.
  @param {array} pkd - The transmission key of the recipient (this is a curve point
  represented as an array of two hex strings).
  @returns {Promise} Resolves into the Ethereum transaction receipt.
  */
  async transfer(
    offchain = false,
    ercAddress,
    tokenType,
    value,
    tokenId,
    pkd,
    fee = this.defaultFee,
  ) {
    const res = await axios.post(`${this.clientBaseUrl}/transfer`, {
      offchain,
      ercAddress,
      tokenId,
      recipientData: {
        values: [value],
        recipientPkds: [pkd],
      },
      nsk: this.zkpKeys.nsk,
      ask: this.zkpKeys.ask,
      fee,
    });
    if (!offchain) {
      return this.submitTransaction(res.data.txDataToSign, this.shieldContractAddress, fee);
    }
    return res.status;
  }

  /**
  Withdraws a token from Layer 2 back to Layer 1. It can then be withdrawn from
  the Shield contract's account by the owner in Layer 1.
  @method
  @async
  @param {number} fee - The amount (Wei) to pay a proposer for the transaction
  @param {string} ercAddress - The address of the ERCx contract from which the token
  is being taken.  Note that the Nightfall_3 State.sol contract must be approved
  by the token's owner to be able to withdraw the token.
  @param {string} tokenType - The type of token to deposit. Possible values are
  'ERC20', 'ERC721', 'ERC1155'.
  @param {number} value - The value of the token, in the case of an ERC20 or ERC1155
  token.  For ERC721 this should be set to zero.
  @param {string} tokenId - The ID of an ERC721 or ERC1155 token.  In the case of
  an 'ERC20' coin, this should be set to '0x00'.
  @param {object} keys - The ZKP private key set of the sender.
  @param {string} recipientAddress - The Ethereum address to where the withdrawn tokens
  should be deposited.
  @returns {Promise} Resolves into the Ethereum transaction receipt.
  */
  async withdraw(
    offchain = false,
    ercAddress,
    tokenType,
    value,
    tokenId,
    recipientAddress,
    fee = this.defaultFee,
  ) {
    const res = await axios.post(`${this.clientBaseUrl}/withdraw`, {
      offchain,
      ercAddress,
      tokenId,
      tokenType,
      value,
      recipientAddress,
      nsk: this.zkpKeys.nsk,
      ask: this.zkpKeys.ask,
      fee,
    });
    this.latestWithdrawHash = res.data.transaction.transactionHash;
    if (!offchain) {
      const receiptPromise = this.submitTransaction(
        res.data.txDataToSign,
        this.shieldContractAddress,
        fee,
      );
      return receiptPromise;
    }
    return res.status;
  }

  /**
  Enables someone with a valid withdraw transaction in flight to finalise the
  withdrawal of funds to L1 (only relevant for ERC20).
  @method
  @async
  @param {string} withdrawTransactionHash - the hash of the Layer 2 transaction in question
  */
  async finaliseWithdrawal(withdrawTransactionHash) {
    // find the L2 block containing the L2 transaction hash
    let res = await axios.get(
      `${this.optimistBaseUrl}/block/transaction-hash/${withdrawTransactionHash}`,
    );
    const { block, transactions, index } = res.data;
    res = await axios.post(`${this.clientBaseUrl}/finalise-withdrawal`, {
      block,
      transactions,
      index,
    });
    return this.submitTransaction(res.data.txDataToSign, this.shieldContractAddress, 0);
  }

  /**
  Enables someone with a valid withdraw transaction in flight to request instant
  withdrawal of funds (only relevant for ERC20).
  @method
  @async
  @param {string} withdrawTransactionHash - the hash of the Layer 2 transaction in question
  @param {number} fee - the amount being paid for the instant withdrawal service
  */
  async requestInstantWithdrawal(withdrawTransactionHash, fee) {
    // find the L2 block containing the L2 transaction hash
    let res = await axios.get(
      `${this.optimistBaseUrl}/block/transaction-hash/${withdrawTransactionHash}`,
    );
    const { block, transactions, index } = res.data;
    // set the instant withdrawal fee
    res = await axios.post(`${this.clientBaseUrl}/set-instant-withdrawal`, {
      block,
      transactions,
      index,
    });
    return this.submitTransaction(res.data.txDataToSign, this.shieldContractAddress, fee);
  }

  /**
  Enables someone to service a request for an instant withdrawal
  @method
  @async
  @param {string} withdrawTransactionHash - the hash of the Layer 2 transaction in question
  */
  async advanceInstantWithdrawal(withdrawTransactionHash) {
    const res = await axios.post(`${this.optimistBaseUrl}/transaction/advanceWithdrawal`, {
      transactionHash: withdrawTransactionHash,
    });
    return this.submitTransaction(res.data.txDataToSign, this.shieldContractAddress, 0);
  }

  /**
  Gets the hash of the last withdraw transaction - sometimes useful for instant transfers
  @method
  @returns {string} - the transactionHash of the last transaction
  */
  getLatestWithdrawHash() {
    return this.latestWithdrawHash;
  }

  /**
  Returns an event emitter that fires each time an InstantWithdrawalRequested
  event is detected on the blockchain
  */
  async getInstantWithdrawalRequestedEmitter() {
    const emitter = new EventEmitter();
    const connection = new WebSocket(this.optimistWsUrl);
    this.websockets.push(connection); // save so we can close it properly later
    connection.onopen = () => {
      connection.send('instant');
    };
    connection.onmessage = async message => {
      const msg = JSON.parse(message.data);
      const { type, withdrawTransactionHash, paidBy, amount } = msg;
      if (type === 'instant') {
        emitter.emit('data', withdrawTransactionHash, paidBy, amount);
      }
    };
    return emitter;
  }

  /**
  Provides nightfall-client with a set of viewing keys.  Without these,
  it won't listen for BlockProposed events and so won't update its transaction collection
  with information about which are on-line.
  @method
  @async
  @param {object} keys - Object containing the ZKP key set (this may be generated
  with the makeKeys function).
  */
  async subscribeToIncomingViewingKeys() {
    return axios.post(`${this.clientBaseUrl}/incoming-viewing-key`, {
      ivks: [this.zkpKeys.ivk],
      nsks: [this.zkpKeys.nsk],
    });
  }

  /**
  Closes the Nf3 connection to the blockchain and any open websockets to NF_3
  @method
  @async
  */
  close() {
    this.web3.currentProvider.connection.close();
    this.websockets.forEach(websocket => websocket.close());
  }

  /**
  Registers a new proposer and pays the Bond required to register.
  It will use the address of the Ethereum Signing key that is holds to register
  the proposer.
  @method
  @async
  @returns {Promise} A promise that resolves to the Ethereum transaction receipt.
  */
  async registerProposer() {
    const res = await axios.post(`${this.optimistBaseUrl}/proposer/register`, {
      address: this.ethereumAddress,
    });
    return this.submitTransaction(
      res.data.txDataToSign,
      this.proposersContractAddress,
      this.PROPOSER_BOND,
    );
  }

  /**
  De-registers an existing proposer.
  It will use the address of the Ethereum Signing key that is holds to de-register
  the proposer.
  @method
  @async
  @returns {Promise} A promise that resolves to the Ethereum transaction receipt.
  */
  async deregisterProposer() {
    const res = await axios.post(`${this.optimistBaseUrl}/proposer/de-register`, {
      address: this.ethereumAddress,
    });
    return this.submitTransaction(res.data.txDataToSign, this.proposersContractAddress, 0);
  }

  /**
  Withdraw the bond left by the proposer.
  It will use the address of the Ethereum Signing key that is holds to withdraw the bond.
  @method
  @async
  @returns {Promise} A promise that resolves to the Ethereum transaction receipt.
  */
  async withdrawBond() {
    const res = await axios.post(`${this.optimistBaseUrl}/proposer/withdrawBond`, {
      address: this.ethereumAddress,
    });
    return this.submitTransaction(res.data.txDataToSign, this.proposersContractAddress, 0);
  }

  /**
  Get all the list of existing proposers.
  @method
  @async
  @returns {array} A promise that resolves to the Ethereum transaction receipt.
  */
  async getProposers() {
    const res = await axios.get(`${this.optimistBaseUrl}/proposer/proposers`, {
      address: this.ethereumAddress,
    });
    return res.data;
  }

  /**
  Adds a new Proposer peer to a list of proposers that are available for accepting
  offchain (direct) transfers and withdraws. The client will submit direct transfers
  and withdraws to all of these peers.
  @method
  @async
  @param {string} peerUrl - the URL of the Proposer being added. This will be from
  the point of view of nightfall-client, not the SDK user (e.g. 'http://optimist1:80').
  Nightfall-client will use this URL to contact the Proposer.
  */
  async addPeer(peerUrl) {
    if (!this.ethereumAddress)
      throw new Error('Cannot add peer if the Ethereum address for the user is not defined');
    // the peerUrl is from the point of view of the Client e.g. 'http://optimist1:80'
    return axios.post(`${this.clientBaseUrl}/peers/addPeers`, {
      address: this.ethereumAddress,
      enode: peerUrl,
    });
  }

  /**
  Starts a Proposer that listens for blocks and submits block proposal
  transactions to the blockchain.
  @method
  @async
  */
  async startProposer() {
    const connection = new WebSocket(this.optimistWsUrl);
    this.websockets.push(connection); // save so we can close it properly later
    connection.onopen = () => {
      connection.send('blocks');
    };
    connection.onmessage = async message => {
      const msg = JSON.parse(message.data);
      const { type, txDataToSign } = msg;
      if (type === 'block') {
        await this.submitTransaction(txDataToSign, this.stateContractAddress, this.BLOCK_STAKE);
      }
    };
    // add this proposer to the list of peers that can accept direct transfers and withdraws
  }

  /**
  Returns an emitter, whose 'data' event fires whenever a block is
  detected, passing out the transaction needed to propose the block. This
  is a lower level method than `Nf3.startProposer` because it does not sign and
  send the transaction to the blockchain. If required, `Nf3.submitTransaction`
  can be used to do that.
  @method
  @async
  @returns {Promise} A Promise that resolves into an event emitter.
  */
  async getNewBlockEmitter() {
    const newBlockEmitter = new EventEmitter();
    const connection = new WebSocket(this.optimistWsUrl);
    this.websockets.push(connection); // save so we can close it properly later
    connection.onopen = () => {
      connection.send('blocks');
    };
    connection.onmessage = async message => {
      const msg = JSON.parse(message.data);
      const { type, txDataToSign } = msg;
      if (type === 'block') {
        newBlockEmitter.emit('data', txDataToSign);
      }
    };
    return newBlockEmitter;
  }

  /**
  Registers our address as a challenger address with the optimist container.
  This is so that the optimist container can tell when a challenge that we have
  committed to has appeared on chain.
  @method
  @async
  @return {Promise} A promise that resolves to an axios response.
  */
  async registerChallenger() {
    return axios.post(`${this.optimistBaseUrl}/challenger/add`, { address: this.ethereumAddress });
  }

  /**
  De-registers our address as a challenger address with the optimist container.
  @method
  @async
  @return {Promise} A promise that resolves to an axios response.
  */
  async deregisterChallenger() {
    return axios.post(`${this.optimistBaseUrl}/challenger/remove`, {
      address: this.ethereumAddress,
    });
  }

  /**
  Starts a Challenger that listens for challengable blocks and submits challenge
  transactions to the blockchain to challenge the block.
  @method
  @async
  */
  async startChallenger() {
    const connection = new WebSocket(this.optimistWsUrl);
    this.websockets.push(connection); // save so we can close it properly later
    connection.onopen = () => {
      connection.send('challenge');
    };
    connection.onmessage = async message => {
      const msg = JSON.parse(message.data);
      const { type, txDataToSign } = msg;
      if (type === 'challenge') {
        await this.submitTransaction(txDataToSign, this.stateContractAddress, 0);
      }
    };
  }

  /**
  Returns an emitter, whose 'data' event fires whenever a challengeable block is
  detected, passing out the transaction needed to raise the challenge. This
  is a lower level method than `Nf3.startChallenger` because it does not sign and
  send the transaction to the blockchain. If required, `Nf3.submitTransaction`
  can be used to do that.
  @method
  @async
  @returns {Promise} A Promise that resolves into an event emitter.
  */
  async getChallengeEmitter() {
    const newChallengeEmitter = new EventEmitter();
    const connection = new WebSocket(this.optimistWsUrl);
    this.websockets.push(connection); // save so we can close it properly later
    connection.onopen = () => {
      connection.send('blocks');
    };
    connection.onmessage = async message => {
      const msg = JSON.parse(message.data);
      const { type, txDataToSign } = msg;
      if (type === 'challenge') {
        newChallengeEmitter.emit('data', txDataToSign);
      }
    };
    return newChallengeEmitter;
  }

  /**
  Returns the balance of tokens held in layer 2
  @method
  @async
  @returns {Promise} This promise rosolves into an object whose properties are the
  addresses of the ERC contracts of the tokens held by this account in Layer 2. The
  value of each propery is the number of tokens originating from that contract.
  */
  async getLayer2Balances() {
    const res = await axios.get(`${this.clientBaseUrl}/commitment/balance`);
    return res.data.balance;
  }

  /**
  Returns the commitments of tokens held in layer 2
  @method
  @async
  @returns {Promise} This promise rosolves into an object whose properties are the
  addresses of the ERC contracts of the tokens held by this account in Layer 2. The
  value of each propery is an array of commitments originating from that contract.
  */
  async getLayer2Commitments() {
    const res = await axios.get(`${this.clientBaseUrl}/commitment/commitments`);
    return res.data.commitments;
  }

  /**
  Set a Web3 Provider URL
  @param {String|Object} providerData - Network url (i.e, http://localhost:8544) or an Object with the information to set the provider
  */
  setWeb3Provider(providerData) {
    if (typeof providerData === 'string' || typeof window === 'undefined') {
      this.web3 = new Web3(providerData);
    }

    if (typeof window !== 'undefined' && window.ethereum) {
      this.web3 = new Web3(window.ethereum);
      window.ethereum.send('eth_requestAccounts');
    }
  }

  /**
  Web3 provider getter
  @returns {Object} provider
  */
  getWeb3Provider() {
    return this.web3;
  }

  /**
  Get Ethereum Balance
  @param {String} address - Ethereum address of account
  @returns {String} - Ether balance in account
  */
  getL1Balance(address) {
    return this.web3.eth.getBalance(address).then(function (balanceWei) {
      return Web3.utils.fromWei(balanceWei);
    });
  }

  /**
  Get EthereumAddress available.
  @param {String} privateKey - Private Key - optional
  @returns {String} - Ether balance in account
  */
  getAccounts() {
    const account =
      this.ethereumSigningKey.length === 0
        ? this.web3.eth.getAccounts().then(address => address[0])
        : this.web3.eth.accounts.privateKeyToAccount(this.ethereumSigningKey).address;
    return account;
  }

  /**
  Signs a message with a given authenticated account
  @param {String} msg  - Message to sign
  @param {String } account - Ethereum address of account
  @returns {Promise} - string with the signature
  */
  signMessage(msg, account) {
    return this.web3.eth.personal.sign(msg, account);
  }

  /**
  Returns current network ID
  @returns {Promise} - Network Id number
  */
  getNetworkId() {
    return this.web3.eth.net.getId();
  }
}

export default Nf3;
