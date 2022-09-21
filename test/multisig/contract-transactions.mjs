/* ignore unused exports */
import logger from 'common-files/utils/logger.mjs';
import { MultiSig } from './multisig.mjs';

// eslint-disable-next-line import/prefer-default-export
export class ContractMultiSig {
  multiSig;

  web3;

  contractInstances = [];

  contractInstancesOwnables = [];

  contractInstancesPausables = [];

  constructor(web3Provider, contractInstances, signatureThreshold, chainId, gasLimit) {
    this.web3 = web3Provider;
    this.multiSig = new MultiSig(
      this.web3,
      contractInstances.multisig,
      signatureThreshold,
      chainId,
      gasLimit,
    );
    this.contractInstances = contractInstances;
    this.contractInstancesOwnables.push(
      contractInstances.shield,
      contractInstances.state,
      contractInstances.proposers,
      contractInstances.challenges,
    );
    this.contractInstancesPausables.push(contractInstances.shield, contractInstances.state);
  }

  transferOwnership(newOwnerPrivateKey, signingKey, executorAddress, nonce) {
    logger.info(`transferOwnership: nonce is ${nonce}`);
    const newOwner = this.web3.eth.accounts.privateKeyToAccount(newOwnerPrivateKey, true).address;
    return Promise.all(
      this.contractInstancesOwnables.map(async (ownable, i) => {
        const contractInstance = ownable;
        const data = contractInstance.methods.transferOwnership(newOwner).encodeABI();
        return this.multiSig.addMultiSigSignature(
          data,
          signingKey,
          contractInstance.options.address,
          executorAddress,
          nonce + i,
        );
      }),
    );
  }

  /**
  This function sets the restriction data that the Shield contract is currently using
  */
  async setTokenRestrictions(
    tokenAddress,
    depositRestriction,
    withdrawRestriction,
    signingKey,
    executorAddress,
    nonce,
  ) {
    const data = this.contractInstances.shield.methods
      .setRestriction(tokenAddress, depositRestriction, withdrawRestriction)
      .encodeABI();
    return Promise.all([
      this.multiSig.addMultiSigSignature(
        data,
        signingKey,
        this.contractInstances.shield.options.address,
        executorAddress,
        nonce,
      ),
    ]);
  }

  /**
  This function removes the restriction data that the Shield contract is currently using
  */
  async removeTokenRestrictions(tokenAddress, signingKey, executorAddress, nonce) {
    const data = this.contractInstances.shield.methods.removeRestriction(tokenAddress).encodeABI();
    return Promise.all([
      this.multiSig.addMultiSigSignature(
        data,
        signingKey,
        this.contractInstances.shield.options.address,
        executorAddress,
        nonce,
      ),
    ]);
  }

  pauseContracts(signingKey, executorAddress, nonce) {
    logger.info('All pausable contracts being paused');
    return Promise.all(
      this.contractInstancesPausables.map(async (pausable, i) => {
        const contractInstance = pausable;
        const data = contractInstance.methods.pause().encodeABI();
        return this.multiSig.addMultiSigSignature(
          data,
          signingKey,
          contractInstance.options.address,
          executorAddress,
          nonce + i,
        );
      }),
    );
  }

  unpauseContracts(signingKey, executorAddress, nonce) {
    logger.info('All pausable contracts being unpaused');
    return Promise.all(
      this.contractInstancesPausables.map(async (pausable, i) => {
        const contractInstance = pausable;
        const data = contractInstance.methods.unpause().encodeABI();
        return this.multiSig.addMultiSigSignature(
          data,
          signingKey,
          contractInstance.options.address,
          executorAddress,
          nonce + i,
        );
      }),
    );
  }

  async setBootProposer(newProposerPrivateKey, signingKey, executorAddress, nonce) {
    const newProposer = this.web3.eth.accounts.privateKeyToAccount(
      newProposerPrivateKey,
      true,
    ).address;
    const shieldContractInstance = this.contractInstances.shield;
    const data = shieldContractInstance.methods.setBootProposer(newProposer).encodeABI();
    return Promise.all([
      this.multiSig.addMultiSigSignature(
        data,
        signingKey,
        shieldContractInstance.options.address,
        executorAddress,
        nonce,
      ),
    ]);
  }

  async setBootChallenger(newChallengerPrivateKey, signingKey, executorAddress, nonce) {
    const newChallenger = this.web3.eth.accounts.privateKeyToAccount(
      newChallengerPrivateKey,
      true,
    ).address;
    const shieldContractInstance = this.contractInstances.shield;
    const data = shieldContractInstance.methods.setBootChallenger(newChallenger).encodeABI();
    return Promise.all([
      this.multiSig.addMultiSigSignature(
        data,
        signingKey,
        shieldContractInstance.options.address,
        executorAddress,
        nonce,
      ),
    ]);
  }

  async setMaticAddress(newMaticAddress, signingKey, executorAddress, nonce) {
    const shieldContractInstance = this.contractInstances.shield;
    const data = shieldContractInstance.methods.setMaticAddress(newMaticAddress).encodeABI();
    return Promise.all([
      this.multiSig.addMultiSigSignature(
        data,
        signingKey,
        shieldContractInstance.options.address,
        executorAddress,
        nonce,
      ),
    ]);
  }
}
