import { ConfigService } from './config.service';
import { AlgoAccount, AssetTransferDto } from './algoAsset.entity';

const config = new ConfigService();
const algosdk = require('algosdk');

const env = config.get('ENV');

const baseServer = 'https://testnet-algorand.api.purestake.io/ps2';

const indexerServer = 'https://testnet-algorand.api.purestake.io/idx2';

const port = '';
const token = {
  'X-API-key': config.get('PURESTAKE_KEY'),
};

// The Indexer API is used for querying historical information from the blockchain, getting information about blocks, assets, accounts and transactions.
let indexerClient = new algosdk.Indexer(token, indexerServer, port);

// The Algod v2 API is used to interact with the blockchain, querying current state, obtaining transaction parameteres and posting transactions.
let algoClient = new algosdk.Algodv2(token, baseServer, port);

export class AssetService {
  constructor() {}

  public async lookupAddressById(address: string): Promise<any> {
    let asset = await indexerClient.lookupAccountByID(address).do();
    return asset;
  }

  public async getAlgoAssets(assetName: string) {
    (async () => {
      let asset = await indexerClient
        .searchForAssets()
        .limit(10)
        .name(assetName)
        .do();
      console.log(asset);
      return asset;
    })().catch((e) => {
      console.log(e);
    });
  }

  public async lookupAssetsById(assetId: number) {
    let asset = await indexerClient
      .lookupAssetByID(assetId)
      .do()
      .catch((e) => {
        console.log(e);
        return Promise.reject("Can't find asset with that id");
      });

    return asset;
  }

  public async lookupAssetsBalances(assetId: number) {
    return (async () => {
      let balances = await indexerClient.lookupAssetBalances(assetId).do();

      return balances;
    })().catch((e) => {
      console.log(e);
    });
  }

  public async generateAlgorandAccount(): Promise<any> {
    const account = algosdk.generateAccount();
    const mnemonic = algosdk.secretKeyToMnemonic(account.sk);

    const newAccount = {
      address: account.addr,
      mnemonic,
    };
    return newAccount;
  }

  // Each account need a userId as reference. The mnemonic should never be shared outside the api.
  public async createAlgoAccount(adminAccount: AlgoAccount) {
    const { address, mnemonic } = await this.generateAlgorandAccount();

    //Send 1 algo to the account so that account can accept transactions
    await this.sendAlgos(adminAccount.mnemonic, address, 1000000).catch((err) =>
      console.log(err),
    );
  }

  public async createNewAlgoAsset(
    data: {
      totalTokens: number;
      tokenName: string;
      address: string;
    },
    mnemonic,
  ) {
    if (!data || !data.totalTokens || !data.tokenName || !data.address) {
      return Promise.reject('Not enough data provided to create the asset');
    }

    const { totalTokens, tokenName, address } = data;

    const sender = algosdk.mnemonicToSecretKey(mnemonic);

    let params = await algoClient.getTransactionParams().do();

    const feePerByte = 1;
    const firstValidRound = params.firstRound;
    const lastValidRound = params.lastRound;
    const genesisHash = params.genesisHash;

    const total = Number(totalTokens); // how many of this asset there will be
    const decimals = 0; // units of this asset are whole-integer amounts
    const assetName = tokenName;
    const unitName = 'units';
    const url = 'www.example.com';
    const metadata = new Uint8Array(
      Buffer.from(`Example metadata here`, 'hex'),
    ); // should be a 32-byte hash
    const defaultFrozen = false; // whether accounts should be frozen by default

    // create suggested parameters
    const suggestedParams = {
      flatFee: false,
      fee: feePerByte,
      firstRound: firstValidRound,
      lastRound: lastValidRound,
      genesisHash,
    };

    const txn = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
      from: address,
      total,
      decimals,
      assetName,
      unitName,
      assetURL: url,
      assetMetadataHash: metadata,
      defaultFrozen,
      freeze: address,
      manager: address,
      clawback: address,
      reserve: address,
      suggestedParams,
    });

    // sign the transaction
    const signedTxn = txn.signTxn(sender.sk);

    // // print transaction data
    // const decoded = algosdk.decodeSignedTransaction(signedTxn);

    let sendTx = await algoClient.sendRawTransaction(signedTxn).do();

    await this.waitForConfirmation(algoClient, sendTx.txId);

    let ptx = await algoClient.pendingTransactionInformation(sendTx.txId).do();

    const assetId = ptx['asset-index'];

    return { assetId };
  }

  // Function used to wait for a tx confirmation
  public waitForConfirmation = async function (algodclient, txId) {
    let response = await algodclient.status().do();
    let lastround = response['last-round'];
    while (true) {
      const pendingInfo = await algodclient
        .pendingTransactionInformation(txId)
        .do();
      if (
        pendingInfo['confirmed-round'] !== null &&
        pendingInfo['confirmed-round'] > 0
      ) {
        //Got the completed Transaction
        console.log(
          'Transaction ' +
            txId +
            ' confirmed in round ' +
            pendingInfo['confirmed-round'],
        );
        break;
      }
      lastround++;
      await algodclient.statusAfterBlock(lastround).do();
    }
  };

  // Function used to print asset holding for account and assetid
  public printAssetHolding = async function (algodclient, account, assetid) {
    // note: if you have an indexer instance available it is easier to just use this
    //     let accountInfo = await indexerClient.searchAccounts()
    //    .assetID(assetIndex).do();
    // and in the loop below use this to extract the asset for a particular account
    // accountInfo['accounts'][idx][account]);
    let accountInfo = await algodclient.accountInformation(account).do();
    for (let idx = 0; idx < accountInfo['assets'].length; idx++) {
      let scrutinizedAsset = accountInfo['assets'][idx];
      if (scrutinizedAsset['asset-id'] == assetid) {
        let myassetholding = JSON.stringify(scrutinizedAsset, undefined, 2);
        console.log('assetholdinginfo = ' + myassetholding);
        break;
      }
    }
  };

  // Used by the controller to transfer an asset
  public async createAssetTransferWithAssetInfo({
    senderAccount,
    recipientAccount,
    assetId,
    amount,
  }: AssetTransferDto) {
    // Create opt in from recipient user (will send zero assets to recipient)
    await this.assetTransferOptIn(recipientAccount, assetId);

    // Create the transfer
    await this.createAssetTransfer(
      Number(amount),
      senderAccount,
      recipientAccount,
      assetId,
    );
  }

  // This assumes the recipient already opted in to receive the asset
  public async createAssetTransfer(
    amount: number,
    senderAccount: AlgoAccount,
    recipientAccount: AlgoAccount,
    assetId: number,
  ) {
    const senderSecretKey = algosdk.mnemonicToSecretKey(senderAccount.mnemonic)
      .sk;

    const params = await algoClient.getTransactionParams().do();

    // We set revocationTarget to undefined as
    // This is not a clawback operation
    let revocationTarget = undefined;
    // CloseReaminerTo is set to undefined as
    // we are not closing out an asset
    let closeRemainderTo = undefined;

    const note = undefined;

    // signing and sending "txn" allows sender to begin accepting asset specified by creator and index
    let opttxn = algosdk.makeAssetTransferTxnWithSuggestedParams(
      senderAccount.address,
      recipientAccount.address,
      closeRemainderTo,
      revocationTarget,
      Number(amount),
      note,
      Number(assetId),
      params,
    );

    // Must be signed by the account wishing to opt in to the asset
    const rawSignedTxn = opttxn.signTxn(senderSecretKey);

    let opttx = await algoClient
      .sendRawTransaction(rawSignedTxn)
      .do()
      .catch((err) => console.log(err));

    console.log('Transaction : ' + opttx.txId);

    // wait for transaction to be confirmed
    await this.waitForConfirmation(algoClient, opttx.txId);

    //You should now see the new asset listed in the account information
    console.log('Account = ' + recipientAccount.address);
    await this.printAssetHolding(algoClient, recipientAccount.address, assetId);
  }

  // Opting in to an Asset:
  // Opting in to transact with the new asset
  // Allow accounts that want receive the new asset
  // Have to opt in. To do this they send an asset transfer
  // of zero  to themselves
  public async assetTransferOptIn(account: AlgoAccount, assetId) {
    await this.createAssetTransfer(0, account, account, assetId);
  }

  // Send algorand tokens from address to address
  public async sendAlgos(
    senderMnemonic: string,
    recipientAddress: string,
    amount: number,
  ) {
    (async () => {
      let params = await algoClient.getTransactionParams().do();

      var senderAccount = algosdk.mnemonicToSecretKey(senderMnemonic);

      let txn = {
        from: senderAccount.addr,
        to: recipientAddress,
        fee: 1,
        amount,
        firstRound: params.firstRound,
        lastRound: params.lastRound,
        genesisID: params.genesisID,
        genesisHash: params.genesisHash,
        note: new Uint8Array(0),
      };

      let signedTxn = algosdk.signTransaction(txn, senderAccount.sk);
      let sendTx = await algoClient.sendRawTransaction(signedTxn.blob).do();

      console.log('Transaction : ' + sendTx.txId);
    })().catch((e) => {
      console.log(e);
    });
  }

  public async initiateAssetClawback(
    holderAccount: AlgoAccount,
    targetAccount: AlgoAccount,
    assetId: number,
    amount: number,
  ) {
    await this.lookupAssetsById(assetId).catch((err) => Promise.reject(err));

    let params = await algoClient.getTransactionParams().do();

    // create the asset revoke transaction
    const transactionOptions = {
      from: holderAccount.address,
      to: holderAccount.address,
      revocationTarget: targetAccount.address,
      amount: Number(amount),
      assetIndex: Number(assetId),
      suggestedParams: params,
    };

    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject(
      transactionOptions,
    );

    await this.signTxnAndSend(txn, holderAccount);

    await this.printAssetHolding(algoClient, targetAccount.address, assetId);
  }

  // All assets need to be in creator address before they can be destroyed
  public async assetDestroy(assetId: number, holderAccount: AlgoAccount) {
    await this.lookupAssetsById(assetId).catch((err) => Promise.reject(err));

    let params = await algoClient.getTransactionParams().do();

    // create the asset revoke transaction
    const transactionOptions = {
      from: holderAccount.address,
      assetIndex: Number(assetId),
      suggestedParams: params,
    };
    const txn = algosdk.makeAssetDestroyTxnWithSuggestedParamsFromObject(
      transactionOptions,
    );

    await this.signTxnAndSend(txn, holderAccount);
  }

  public async signTxnAndSend(txn, account: AlgoAccount) {
    const adminSk = algosdk.mnemonicToSecretKey(account.mnemonic).sk;
    // sign the transaction
    const signedTxn = txn.signTxn(adminSk);

    // print transaction data
    //  const decoded = algosdk.decodeSignedTransaction(signedTxn);
    //  console.log(decoded);

    let opttx = await algoClient
      .sendRawTransaction(signedTxn)
      .do()
      .catch((err) => console.log(err));

    console.log('Transaction : ' + opttx.txId);

    // wait for transaction to be confirmed
    await this.waitForConfirmation(algoClient, opttx.txId);
  }
}
