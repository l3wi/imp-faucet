const { router, get } = require('microrouter')
const { json, send } = require('micro')
const cors = require('micro-cors')()
const path = require('path')
const homedir = require('os').homedir()

const {
  composeAPI,
  createPrepareTransfers,
  generateAddress,
} = require('@iota/core')
const { asTransactionObject } = require('@iota/transaction-converter')
var flatCache = require('flat-cache')
var cache = flatCache.load('.wallet', path.resolve(homedir))

const provider = 'https://comnet.iota.works'
const initalSeed =
  'NLRMWYYCDUVF9XQJYDFNNYTBSKPFKNHSDZWLLJOEDMDFRTDAZEPKYIHCTURJYYHHYQBMMYO9HOCBFDKSK'

// Fetch Facuet Wallet
const getIotaWallet = () => {
  let store = cache.getKey('wallet') // { foo: 'var' }
  if (!store || !store.seed) {
    store = {
      seed: initalSeed,
      keyIndex: 0,
      defaultBalance: 20000,
    }
    cache.setKey('wallet', store)
    cache.save()
  }

  const { keyIndex, seed, defaultBalance } = store
  return { keyIndex, seed, defaultBalance }
}

const setIotaWallet = (remainderAddress, keyIndex) => {
  let store = cache.getKey('wallet') // { foo: 'var' }
  store.address = remainderAddress
  store.keyIndex = keyIndex
  cache.setKey('wallet', store)
  cache.save()
}

// Get balance of the Wallet
const getBalance = async (address) => {
  try {
    if (!address) return 0

    const { getBalances } = composeAPI({ provider })
    const { balances } = await getBalances([address], 100)
    return balances && balances.length > 0 ? balances[0] : 0
  } catch (error) {
    console.error('getBalance error', error)
    return 0
  }
}

const repairWallet = async (seed, keyIndex) => {
  try {
    // Iterating through keyIndex ordered by likelyhood
    for (const value of [-2, -1, 1, 2, 3, 4, -3, -4, -5, -6, -7, 5, 6, 7]) {
      const newIndex = Number(keyIndex) + Number(value)
      if (newIndex >= 0) {
        const newAddress = await generateAddress(seed, newIndex)
        const newBalance = await getBalance(newAddress)
        if (newBalance > 0) {
          console.log(
            `Repair wallet executed. Old keyIndex: ${keyIndex}, new keyIndex: ${newIndex}. New wallet balance: ${newBalance}. New address: ${newAddress}`
          )
          return { address: newAddress, keyIndex: newIndex }
        }
      }
    }
  } catch (error) {
    console.log('Repair wallet Error', error)
    return error
  }
}

const transferFunds = async (
  receiveAddress,
  address,
  keyIndex,
  seed,
  value,
  updateFn,
  userId = null
) => {
  try {
    const { getBalances, sendTrytes, getLatestInclusion } = composeAPI({
      provider,
    })
    const prepareTransfers = createPrepareTransfers()
    const { balances } = await getBalances([address], 100)
    const security = 2
    const balance = balances && balances.length > 0 ? balances[0] : 0

    // Depth or how far to go for tip selection entry point
    const depth = 3

    // Difficulty of Proof-of-Work required to attach transaction to tangle.
    // Minimum value on mainnet & spamnet is `14`, `9` on devnet and other testnets.
    const minWeightMagnitude = 10

    if (balance === 0) {
      console.error('transferFunds. Insufficient balance', address, balances)
      return null
    }

    const promise = new Promise((resolve, reject) => {
      const transfers = [{ address: receiveAddress, value }]
      const remainderAddress = generateAddress(seed, keyIndex + 1)
      const options = {
        inputs: [
          {
            address,
            keyIndex,
            security,
            balance,
          },
        ],
        security,
        remainderAddress,
      }

      prepareTransfers(seed, transfers, options)
        .then(async (trytes) => {
          sendTrytes(trytes, depth, minWeightMagnitude)
            .then(async (transactions) => {
              setIotaWallet(remainderAddress, keyIndex + 1, userId)
              const hashes = transactions.map((transaction) => transaction.hash)

              let retries = 0
              while (retries++ < 20) {
                const statuses = await getLatestInclusion(hashes)
                if (statuses.filter((status) => status).length === 4) break
                await new Promise((resolved) => setTimeout(resolved, 10000))
              }

              resolve(transactions)
            })
            .catch((error) => {
              console.error('transferFunds sendTrytes error', error)
              reject(error)
            })
        })
        .catch((error) => {
          console.error('transferFunds prepareTransfers error', error)
          reject(error)
        })
    })
    return promise
  } catch (error) {
    console.error('transferFunds catch', error)
    return error
  }
}

const initSemarketWallet = async (receiveAddress, desiredBalance = null) => {
  let { keyIndex, seed, defaultBalance } = await getIotaWallet() //
  let address = await generateAddress(seed, keyIndex)
  const IotaWalletBalance = await getBalance(address)

  if (IotaWalletBalance === 0) {
    const newIotaWallet = await repairWallet(seed, keyIndex)
    if (newIotaWallet && newIotaWallet.address && newIotaWallet.keyIndex) {
      address = newIotaWallet.address
      keyIndex = newIotaWallet.keyIndex
    }
  }

  const balance = desiredBalance ? Number(desiredBalance) : defaultBalance

  const transactions = await transferFunds(
    receiveAddress,
    address,
    keyIndex,
    seed,
    balance,
    null,
    null
  )
  return transactions
}

const semarket = async (req, res) => {
  try {
    const params = req.query
    if (params.address) {
      const transactions = await initSemarketWallet(
        params.address,
        params.amount || null
      )
      console.log('semarket wallet transactions:', transactions.length)
      return send(res, 200, { success: transactions.length > 0 })
    }
    return send(res, 200, { success: false, error: 'no address' })
  } catch (e) {
    console.error('semarket wallet failed. Error: ', e)
    return send(res, 403, { error: e.message })
  }
  const body = await json(req)
}

module.exports = cors(router(get('/', semarket)))
