import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';

import {
  Dinero,
  ERC20Market,
  MintableERC20,
  PriceOracle,
} from '../typechain-types';
import { BTC_USD_PRICE_FEED, deploy, deployUUPS } from './utils';

const { parseEther, defaultAbiCoder } = ethers.utils;

const APPROX_BTC_PRICE = ethers.BigNumber.from('41629290000000000000000');

const INTEREST_RATE = BigNumber.from(12e8);

async function deployFixture() {
  const [owner, alice, bob, treasury] = await ethers.getSigners();

  const [btc, dinero] = await Promise.all([
    deploy('MintableERC20', ['Bitcoin', 'BTC']) as Promise<MintableERC20>,
    deployUUPS('Dinero', []) as Promise<Dinero>,
  ]);

  const priceOracle: PriceOracle = await deployUUPS('PriceOracle', []);

  const contractData = defaultAbiCoder.encode(
    ['address', 'address', 'address', 'address'],
    [dinero.address, btc.address, priceOracle.address, treasury.address]
  );

  const settingsData = defaultAbiCoder.encode(
    ['uint128', 'uint96', 'uint128', 'uint64'],
    [parseEther('0.5'), parseEther('0.1'), parseEther('1000000'), INTEREST_RATE]
  );

  const erc20Market: ERC20Market = await deployUUPS('ERC20Market', [
    contractData,
    settingsData,
  ]);

  await Promise.all([
    btc.mint(alice.address, parseEther('10000')),
    btc
      .connect(alice)
      .approve(erc20Market.address, ethers.constants.MaxUint256),
    priceOracle.setUSDFeed(btc.address, BTC_USD_PRICE_FEED),
  ]);

  return {
    btc,
    dinero,
    alice,
    owner,
    bob,
    treasury,
    priceOracle,
    erc20Market,
  };
}

describe('ERC20Market', function () {
  describe('function: initialize', function () {
    it('initializes the contract correctly', async () => {
      const { erc20Market, btc, treasury } = await loadFixture(deployFixture);

      const [collateral, treasuryAddress, maxLTVRatio, liquidationFee, terms] =
        await Promise.all([
          erc20Market.COLLATERAL(),
          erc20Market.treasury(),
          erc20Market.maxLTVRatio(),
          erc20Market.liquidationFee(),
          erc20Market.loanTerms(),
        ]);

      expect(collateral).to.be.equal(btc.address);
      expect(treasury.address).to.be.equal(treasuryAddress);
      expect(maxLTVRatio).to.be.equal(parseEther('0.5'));
      expect(liquidationFee).to.be.equal(parseEther('0.1'));
      expect(terms.interestRate).to.be.equal(INTEREST_RATE);
    });
    it('reverts if you try to initialize it again', async () => {
      const { erc20Market } = await loadFixture(deployFixture);
      await expect(
        erc20Market.initialize(
          ethers.constants.HashZero,
          ethers.constants.HashZero
        )
      ).to.revertedWith('Initializable: contract is already initialized');
    });
  });
});
