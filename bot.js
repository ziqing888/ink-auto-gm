const Web3 = require('web3')
const { AbiItem } = require('web3-utils')
const fs = require('fs').promises
const path = require('path')
const chalk = require('chalk')
const PriorityQueue = require('fastpriorityqueue')

// ======================== 配置模块 ========================
const CONFIG = {
  RPC_URL: 'https://rpc-gel.inkonchain.com',
  CONTRACT_ADDRESS: '0x9F500d075118272B3564ac6Ef2c70a9067Fd2d3F',
  PRIVATE_KEY_FILE: path.join(__dirname, 'private_keys.txt'),
  DEFAULT_RECIPIENT: '0x9fb72f1a6f51b99ab21ccb6139acaef4d3ce0a66',
  MAX_RETRIES: 3,
  GAS_MULTIPLIER: 1.2,
  COOLDOWN: {
    SUCCESS: 10000,  
    ERROR: 30000     
  }
}

// ======================== ABI定义 ========================
const ABI = [
  {
    "inputs": [{"internalType": "address","name": "recipient","type": "address"}],
    "name": "gmTo",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{"internalType": "address","name": "user","type": "address"}],
    "name": "lastGM",
    "outputs": [{"internalType": "uint256","name": "lastGM","type": "uint256"}],
    "stateMutability": "view",
    "type": "function"
  }
]

// ======================== 初始化Web3 ========================
const web3 = new Web3(CONFIG.RPC_URL)
const contract = new web3.eth.Contract(ABI, CONFIG.CONTRACT_ADDRESS)

// ======================== 日志系统 ========================
const logger = {
  info: (msg) => console.log(`${chalk.cyan('ℹ')} ${chalk.gray(formatTime())} ${msg}`),
  success: (msg) => console.log(`${chalk.green('✔')} ${chalk.gray(formatTime())} ${msg}`),
  warn: (msg) => console.log(`${chalk.yellow('⚠')} ${chalk.gray(formatTime())} ${msg}`),
  error: (msg) => console.log(`${chalk.red('✖')} ${chalk.gray(formatTime())} ${msg}`)
}

function formatTime() {
  return new Date().toLocaleTimeString('zh-CN', { 
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

// ======================== 核心功能类 ========================
class GMScheduler {
  constructor() {
    this.accounts = []
    this.gasPrice = null
  }

  async initialize() {
    await this.loadAccounts()
    await this.updateGasPrice()
    this.schedulePriceUpdate()
    await this.verifyAddress(CONFIG.DEFAULT_RECIPIENT)
  }

  async loadAccounts() {
    try {
      const content = await fs.readFile(CONFIG.PRIVATE_KEY_FILE, 'utf-8')
      const keys = content.split('\n')
        .map(k => k.trim())
        .filter(k => /^0x[a-fA-F0-9]{64}$/.test(k))

      this.accounts = keys.map(k => ({
        key: k,
        address: web3.eth.accounts.privateKeyToAccount(k).address.toLowerCase()
      }))

      if (this.accounts.length === 0) {
        throw new Error('未找到有效的私钥')
      }
      logger.success(`成功加载 ${this.accounts.length} 个账户`)
    } catch (error) {
      logger.error(`私钥加载失败: ${error.message}`)
      process.exit(1)
    }
  }

  async updateGasPrice() {
    try {
      const current = await web3.eth.getGasPrice()
      this.gasPrice = Math.floor(Number(current) * CONFIG.GAS_MULTIPLIER)
      logger.info(`Gas价格更新: ${web3.utils.fromWei(this.gasPrice.toString(), 'gwei')} Gwei`)
    } catch (error) {
      logger.warn(`Gas价格获取失败: ${error.message}`)
    }
  }

  schedulePriceUpdate() {
    setInterval(() => this.updateGasPrice(), 5 * 60 * 1000)
  }

  async getNextExecution(address) {
    try {
      const timestamp = await contract.methods.lastGM(address).call()
      const lastGM = new Date(timestamp * 1000)
      const nextGM = new Date(lastGM.getTime() + 86400000 + 60000) // 24h+1m
      return { lastGM, nextGM }
    } catch (error) {
      logger.error(`上次GM时间查询失败: ${error.message}`)
      return { lastGM: null, nextGM: new Date() }
    }
  }

  async buildTransaction(sender, recipient) {
    const data = contract.methods.gmTo(recipient).encodeABI()
    const gas = await contract.methods.gmTo(recipient).estimateGas({ from: sender })
    
    return {
      to: CONFIG.CONTRACT_ADDRESS,
      data,
      gas,
      gasPrice: this.gasPrice || await web3.eth.getGasPrice(),
      nonce: await web3.eth.getTransactionCount(sender)
    }
  }

  async sendTransaction(tx, privateKey) {
    let retries = CONFIG.MAX_RETRIES
    
    while (retries > 0) {
      try {
        const signed = await web3.eth.accounts.signTransaction(tx, privateKey)
        return await web3.eth.sendSignedTransaction(signed.rawTransaction)
      } catch (error) {
        retries--
        if (retries === 0) throw error
        logger.warn(`交易失败，剩余重试次数: ${retries}`)
        await delay(CONFIG.COOLDOWN.ERROR)
      }
    }
  }

  getRecipient(sender) {
    if (this.accounts.length === 1) return CONFIG.DEFAULT_RECIPIENT
    const index = this.accounts.findIndex(a => a.address === sender)
    return this.accounts[(index + 1) % this.accounts.length].address
  }

  async verifyAddress(address) {
    if (!web3.utils.isAddress(address)) {
      logger.error(`地址 ${address} 格式无效`)
      process.exit(1)
    }
    logger.success(`地址验证通过: ${shortAddress(address)}`)
  }
}

// ======================== 调度管理器 ========================
class ScheduleManager {
  constructor(scheduler) {
    this.scheduler = scheduler
    this.taskQueue = new PriorityQueue((a, b) => a.execTime - b.execTime)
    this.currentTimer = null
  }

  async init() {
    await this.loadInitialTasks()
    this.scheduleNext()
  }

  async loadInitialTasks() {
    const now = Date.now()
    for (const account of this.scheduler.accounts) {
      const { nextGM } = await this.scheduler.getNextExecution(account.address)
      if (nextGM > now) {
        this.taskQueue.add({ execTime: nextGM.getTime(), account })
      }
    }
    // 修改点：将 size() 改为 size
    logger.info(`任务队列初始化完成，待处理任务: ${this.taskQueue.size}`)
  }

  scheduleNext() {
    if (this.taskQueue.isEmpty()) {
      logger.warn('任务队列为空，60秒后重新检查')
      this.currentTimer = setTimeout(() => this.checkForNewTasks(), 60000)
      return
    }

    const nextTask = this.taskQueue.peek()
    const delay = Math.max(0, nextTask.execTime - Date.now())

    logger.info(`下次执行: ${formatRelativeTime(nextTask.execTime)}`)
    this.currentTimer = setTimeout(() => this.processTasks(), delay)
  }

  async processTasks() {
    while (!this.taskQueue.isEmpty() && this.taskQueue.peek().execTime <= Date.now()) {
      const task = this.taskQueue.poll()
      await this.executeTask(task)
    }
    this.scheduleNext()
  }

  async executeTask(task) {
    try {
      const { account } = task
      const recipient = this.scheduler.getRecipient(account.address)
      const tx = await this.scheduler.buildTransaction(account.address, recipient)
      const receipt = await this.scheduler.sendTransaction(tx, account.key)

      logger.success([
        `发送成功: ${shortAddress(account.address)}`,
        `接收方: ${shortAddress(recipient)}`,
        `交易哈希: ${chalk.underline(receipt.transactionHash)}`
      ].join(' | '))

      const { nextGM } = await this.scheduler.getNextExecution(account.address)
      this.taskQueue.add({ execTime: nextGM.getTime(), account })
      
      await delay(CONFIG.COOLDOWN.SUCCESS)
    } catch (error) {
      logger.error(`任务执行失败: ${error.message}`)
      await delay(CONFIG.COOLDOWN.ERROR)
    }
  }

  async checkForNewTasks() {
    logger.info('执行定期任务检查...')
    await this.loadInitialTasks()
    this.scheduleNext()
  }
}


// ======================== 工具函数 ========================
function shortAddress(address) {
  return address ? `${address.slice(0, 6)}...${address.slice(-4)}` : '未知地址'
}

function formatRelativeTime(timestamp) {
  const diff = timestamp - Date.now()
  const hours = Math.floor(diff / 3600000)
  const minutes = Math.floor((diff % 3600000) / 60000)
  return `${hours}小时${minutes}分钟后`
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ======================== 主程序 ========================
function showHeader() {
  const title = `
${chalk.cyanBright.bold('╔══════════════════════════════════════════════════╗')}
${chalk.cyanBright.bold('║                                                  ║')}
${chalk.cyanBright.bold('║')}   ${chalk.yellowBright.bold('每日自动')} ${chalk.magentaBright.bold('GM')} ${chalk.yellowBright.bold('机器人')}                             ${chalk.cyanBright.bold('║')}
${chalk.cyanBright.bold('║')}   加入我们: ${chalk.greenBright.underline('https://t.me/ksqxszq')}                 ${chalk.cyanBright.bold('║')}
${chalk.cyanBright.bold('║                                                  ║')}
${chalk.cyanBright.bold('╚══════════════════════════════════════════════════╝')}
  `;

  console.log(title);
}



async function main() {
  showHeader()
  try {
    const scheduler = new GMScheduler()
    await scheduler.initialize()
    
    const manager = new ScheduleManager(scheduler)
    await manager.init()

    process.on('SIGINT', () => {
      logger.info('正在优雅退出...')
      if (manager.currentTimer) clearTimeout(manager.currentTimer)
      process.exit()
    })
  } catch (error) {
    logger.error(`程序启动失败: ${error.message}`)
    process.exit(1)
  }
}

main()
