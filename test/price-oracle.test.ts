import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';

import {
  BrokenPriceFeed,
  MintableERC20,
  PriceOracle,
  PriceOracleV2,
} from '../typechain-types';
import {
  BTC_USD_PRICE_FEED,
  deploy,
  deployUUPS,
  ETHER_USD_PRICE_FEED,
  multiDeploy,
  sqrt,
  upgrade,
  WRAPPED_NATIVE_TOKEN,
} from './utils';

const { parseEther } = ethers.utils;

const APPROX_BTC_PRICE = ethers.BigNumber.from('41629290000000000000000');

const APPROX_ETH_PRICE = ethers.BigNumber.from('3015219835010000000000');

async function deployFixture() {
  const [owner, alice, bob] = await ethers.getSigners();

  const [[btc, ether], priceOracle, brokenPriceFeed] = await Promise.all([
    multiDeploy(
      ['MintableERC20', 'MintableERC20'],
      [
        ['Bitcoin', 'BTC'],
        ['Ether', 'ETH'],
      ]
    ) as Promise<Array<MintableERC20>>,
    deployUUPS('PriceOracle', [WRAPPED_NATIVE_TOKEN]) as Promise<PriceOracle>,
    deploy('BrokenPriceFeed', []) as Promise<BrokenPriceFeed>,
  ]);

  const factory = await (await ethers.getContractFactory('Factory')).deploy();

  await factory.connect(owner).createPair(btc.address, ether.address, false);
  const volatilePairAddress = await factory.getPair(
    btc.address,
    ether.address,
    false
  );

  const volatilePair = (await ethers.getContractFactory('Pair')).attach(
    volatilePairAddress
  );

  await Promise.all([
    btc.mint(alice.address, parseEther('10000')),
    ether.mint(alice.address, parseEther('5000')),
    priceOracle.setUSDFeed(btc.address, BTC_USD_PRICE_FEED),
    priceOracle.setUSDFeed(ether.address, ETHER_USD_PRICE_FEED),
  ]);

  return {
    ether,
    btc,
    alice,
    owner,
    bob,
    brokenPriceFeed,
    volatilePair,
    priceOracle,
  };
}

describe('PriceOracle', function () {
  describe('function: initialize', () => {
    it('reverts if you try to initialize it after deployment', async () => {
      const { priceOracle } = await loadFixture(deployFixture);

      await expect(
        priceOracle.initialize(WRAPPED_NATIVE_TOKEN)
      ).to.revertedWith('Initializable: contract is already initialized');
    });

    it('initializes the data correctly', async () => {
      const { priceOracle, owner } = await loadFixture(deployFixture);

      expect(await priceOracle.owner()).to.be.equal(owner.address);
      expect(await priceOracle.WRAPPED_NATIVE_TOKEN()).to.be.equal(
        WRAPPED_NATIVE_TOKEN
      );
    });
  });

  describe('function: getTokenUSDPrice', () => {
    it('reverts if the argument if the amount is 0 or the address if address(0)', async () => {
      const { priceOracle, btc } = await loadFixture(deployFixture);

      await expect(
        priceOracle.getTokenUSDPrice(ethers.constants.AddressZero, 1)
      ).to.rejectedWith('PriceOracle__InvalidAddress()');

      await expect(
        priceOracle.getTokenUSDPrice(btc.address, 0)
      ).to.rejectedWith('PriceOracle__InvalidAmount()');
    });

    it('reverts if there is no price is found or the price is invalid', async () => {
      const { priceOracle, btc, alice, brokenPriceFeed } = await loadFixture(
        deployFixture
      );

      await expect(
        priceOracle.getTokenUSDPrice(alice.address, 10)
      ).to.rejectedWith('PriceOracle__MissingFeed()');

      await priceOracle.setUSDFeed(btc.address, brokenPriceFeed.address);

      await expect(
        priceOracle.getTokenUSDPrice(btc.address, 10)
      ).to.rejectedWith('PriceOracle__InvalidPrice()');
    });

    it('returns the asset price', async () => {
      const { priceOracle, btc } = await loadFixture(deployFixture);

      const answer = await priceOracle.getTokenUSDPrice(
        btc.address,
        parseEther('1')
      );

      expect(answer).to.be.closeTo(APPROX_BTC_PRICE, parseEther('1'));

      expect(
        await priceOracle.getTokenUSDPrice(btc.address, parseEther('2.7'))
      ).to.be.equal(answer.mul(parseEther('2.7')).div(parseEther('1')));
    });
  });

  describe('function: getIPXLPTokenUSDPrice', () => {
    it('reverts if the argument if the amount is 0 or the address if address(0)', async () => {
      const { priceOracle, btc } = await loadFixture(deployFixture);

      await expect(
        priceOracle.getIPXLPTokenUSDPrice(ethers.constants.AddressZero, 1)
      ).to.rejectedWith('PriceOracle__InvalidAddress()');

      await expect(
        priceOracle.getIPXLPTokenUSDPrice(btc.address, 0)
      ).to.rejectedWith('PriceOracle__InvalidAmount()');
    });

    it('reverts if there is no price is found or the price is invalid', async () => {
      const { priceOracle, btc, alice, brokenPriceFeed, ether, volatilePair } =
        await loadFixture(deployFixture);

      await priceOracle.setUSDFeed(btc.address, ethers.constants.AddressZero);

      await expect(
        priceOracle.getIPXLPTokenUSDPrice(volatilePair.address, 10)
      ).to.rejectedWith('PriceOracle__MissingFeed()');

      await Promise.all([
        priceOracle.setUSDFeed(btc.address, BTC_USD_PRICE_FEED),
        priceOracle.setUSDFeed(ether.address, ethers.constants.AddressZero),
      ]);

      await expect(
        priceOracle.getIPXLPTokenUSDPrice(volatilePair.address, 10)
      ).to.rejectedWith('PriceOracle__MissingFeed()');

      await priceOracle.setUSDFeed(ether.address, brokenPriceFeed.address);

      await expect(
        priceOracle.getIPXLPTokenUSDPrice(volatilePair.address, 10)
      ).to.rejectedWith('PriceOracle__InvalidPrice()');

      await Promise.all([
        priceOracle.setUSDFeed(btc.address, brokenPriceFeed.address),
        priceOracle.setUSDFeed(ether.address, ETHER_USD_PRICE_FEED),
      ]);

      await expect(
        priceOracle.getIPXLPTokenUSDPrice(volatilePair.address, 10)
      ).to.rejectedWith('PriceOracle__InvalidPrice()');
    });

    it('calculates the fair price of a LP token', async () => {
      const { priceOracle, btc, ether, volatilePair, alice } =
        await loadFixture(deployFixture);

      await Promise.all([
        btc.connect(alice).transfer(volatilePair.address, parseEther('3')),
        ether.connect(alice).transfer(volatilePair.address, parseEther('41.4')),
      ]);

      await volatilePair.mint(alice.address);

      const totalSupply = await volatilePair.totalSupply();

      const etherReserveInUSD = parseEther('41.4')
        .mul(APPROX_ETH_PRICE)
        .div(parseEther('1'));

      const btcReserveInUSD = parseEther('3')
        .mul(APPROX_BTC_PRICE)
        .div(parseEther('1'));

      const lpTokenPrice = etherReserveInUSD
        .add(btcReserveInUSD)
        .mul(parseEther('1'))
        .div(totalSupply);

      expect(
        await priceOracle.getIPXLPTokenUSDPrice(
          volatilePair.address,
          parseEther('10')
        )
      ).to.be.closeTo(
        lpTokenPrice.mul(parseEther('10')).div(parseEther('1')),
        parseEther('1') // 1 dollar
      );

      // @notice someone changes the K to trick the oracle
      await ether
        .connect(alice)
        .transfer(volatilePair.address, parseEther('200'));

      await volatilePair.sync();

      // Fair K of 1 BTC === 13.8 ETH so K = 13.8
      const fairK = APPROX_BTC_PRICE.mul(parseEther('1')).div(APPROX_ETH_PRICE);
      // Current K after the hack
      const currentK = parseEther('241.4')
        .mul(parseEther('3'))
        .div(parseEther('1'));

      // To find the fair ratio. We divide currentK by fairK.
      // Since our fairK is calculated by 1 BTC.
      // The square root of (currentK/fairK) is the fair BTC amount
      const multiplier = sqrt(currentK.mul(parseEther('1')).div(fairK)).mul(
        BigNumber.from(10).pow(9)
      );

      const fairBTCAmount = multiplier;
      const fairETHAmount = currentK.mul(parseEther('1')).div(multiplier);

      // Find fair price based on new K
      const price = fairBTCAmount
        .mul(APPROX_BTC_PRICE)
        .div(parseEther('1'))
        .add(fairETHAmount.mul(APPROX_ETH_PRICE).div(parseEther('1')))
        .mul(parseEther('1'))
        .div(totalSupply);

      expect(
        await priceOracle.getIPXLPTokenUSDPrice(
          volatilePair.address,
          parseEther('10')
        )
      ).to.be.closeTo(
        price.mul(parseEther('10')).div(parseEther('1')),
        parseEther('1') // 1 dollar
      );
    });
  });

  describe('function: setUSDFeed', () => {
    it('revert if called by non-owner account', async () => {
      const { priceOracle, alice, btc, brokenPriceFeed } = await loadFixture(
        deployFixture
      );
      await expect(
        priceOracle
          .connect(alice)
          .setUSDFeed(btc.address, brokenPriceFeed.address)
      ).to.revertedWith('Ownable: caller is not the owner');
    });

    it('updates a price feed', async () => {
      const { priceOracle, btc, brokenPriceFeed } = await loadFixture(
        deployFixture
      );

      expect(
        ethers.utils.getAddress(await priceOracle.getUSDFeed(btc.address))
      ).to.be.equal(ethers.utils.getAddress(BTC_USD_PRICE_FEED));

      await expect(priceOracle.setUSDFeed(btc.address, brokenPriceFeed.address))
        .to.emit(priceOracle, 'NewFeed')
        .withArgs(btc.address, brokenPriceFeed.address);

      expect(
        ethers.utils.getAddress(await priceOracle.getUSDFeed(btc.address))
      ).to.be.equal(ethers.utils.getAddress(brokenPriceFeed.address));
    });
  });

  describe('function: upgrade', () => {
    it('reverts if a non-owner account tries to upgrade', async () => {
      const { priceOracle } = await loadFixture(deployFixture);

      await priceOracle.renounceOwnership();

      await expect(upgrade(priceOracle, 'PriceOracleV2')).to.revertedWith(
        'Ownable: caller is not the owner'
      );
    });

    it('upgrades to version2', async () => {
      const { priceOracle, btc } = await loadFixture(deployFixture);
      const priceOracleV2: PriceOracleV2 = await upgrade(
        priceOracle,
        'PriceOracleV2'
      );

      const [version, feed] = await Promise.all([
        priceOracleV2.version(),
        priceOracleV2.getUSDFeed(btc.address),
      ]);

      expect(version).to.be.equal('v2');
      expect(ethers.utils.getAddress(feed)).to.be.equal(
        ethers.utils.getAddress(BTC_USD_PRICE_FEED)
      );
    });
  });
});
