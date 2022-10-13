import '@nomicfoundation/hardhat-toolbox';
import '@openzeppelin/hardhat-upgrades';

import * as dotenv from 'dotenv';
import { HardhatUserConfig } from 'hardhat/config';

dotenv.config({ path: './.env' });

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.17',
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {
      forking: {
        url: process.env.BSC_MAIN_NET_URL || '',
        blockNumber: 15_018_612,
      },
    },
    bsc_test_net: {
      url: process.env.BSC_TEST_NET_URL || '',
      accounts:
        process.env.PRIVATE_KEY !== undefined ? [process.env.PRIVATE_KEY] : [],
    },
  },
};

export default config;
