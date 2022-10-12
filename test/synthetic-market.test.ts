import { anyUint } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  MintableERC20,
  PriceFeed,
  PriceOracle,
  Swap,
  SyntheticMarket,
} from '../typechain-types';
import {
  BRL_USD_PRICE,
  deploy,
  deployUUPS,
  WRAPPED_NATIVE_TOKEN,
} from './utils';

const { parseEther, defaultAbiCoder } = ethers.utils;

const TRANSFER_FEE = parseEther('0.1');

const LIQUIDATION_FEE = parseEther('0.1');

const MAX_LTV_RATIO = parseEther('0.5');

async function deployFixture() {
  const [owner, alice, bob, treasury, jose] = await ethers.getSigners();

  const [busd, priceOracle] = await Promise.all([
    deploy('MintableERC20', ['Bitcoin', 'BTC']) as Promise<MintableERC20>,
    deployUUPS('PriceOracle', [WRAPPED_NATIVE_TOKEN]) as Promise<PriceOracle>,
  ]);

  const erc20Data = defaultAbiCoder.encode(
    ['string', 'string', 'address', 'uint256'],
    ['Interest Brazilian Real', 'iBRL', treasury.address, TRANSFER_FEE]
  );

  const settingsData = defaultAbiCoder.encode(
    ['address', 'address', 'uint128', 'uint128'],
    [busd.address, priceOracle.address, MAX_LTV_RATIO, LIQUIDATION_FEE]
  );

  const synthethicMarket: SyntheticMarket = await deployUUPS(
    'SyntheticMarket',
    [erc20Data, settingsData]
  );

  const synt = await synthethicMarket.SYNT();

  const priceFeed: PriceFeed = await deploy('PriceFeed');

  await priceFeed.setPrice(
    BRL_USD_PRICE.div(ethers.BigNumber.from('10000000000'))
  );

  const SYNT = (await ethers.getContractFactory('ERC20Fees')).attach(synt);

  await Promise.all([
    priceOracle.setUSDFeed(synt, priceFeed.address),
    busd.mint(alice.address, parseEther('10000')),
    busd.mint(bob.address, parseEther('10000')),
    busd.mint(jose.address, parseEther('10000')),
    busd
      .connect(alice)
      .approve(synthethicMarket.address, ethers.constants.MaxUint256),
    busd
      .connect(bob)
      .approve(synthethicMarket.address, ethers.constants.MaxUint256),
    busd
      .connect(jose)
      .approve(synthethicMarket.address, ethers.constants.MaxUint256),
  ]);

  return {
    busd,
    synthethicMarket,
    priceOracle,
    owner,
    alice,
    bob,
    jose,
    treasury,
    SYNT,
    priceFeed,
  };
}

describe('SyntheticMarket', function () {
  describe('initialize', function () {
    it('initializes properly', async () => {
      const { synthethicMarket, owner, SYNT, treasury } = await loadFixture(
        deployFixture
      );

      const [synt, _owner, maxLTVRatio, liquidationFee, _treasury] =
        await Promise.all([
          synthethicMarket.SYNT(),
          synthethicMarket.owner(),
          synthethicMarket.maxLTVRatio(),
          synthethicMarket.liquidationFee(),
          SYNT.treasury(),
          SYNT.transferFee(),
        ]);

      expect(synt).to.be.equal(SYNT.address);
      expect(_owner).to.be.equal(owner.address);
      expect(maxLTVRatio).to.be.equal(MAX_LTV_RATIO);
      expect(liquidationFee).to.be.equal(LIQUIDATION_FEE);
      expect(_treasury).to.be.equal(treasury.address);
    });
    it('reverts if you try to initialize it again', async () => {
      const { synthethicMarket } = await loadFixture(deployFixture);
      await expect(
        synthethicMarket.initialize(
          ethers.constants.HashZero,
          ethers.constants.HashZero
        )
      ).to.revertedWith('Initializable: contract is already initialized');
    });
  });

  describe('function: getPendingRewards', function () {
    it('returns 0 if there is the user did not mint any Synt', async () => {
      const { synthethicMarket, alice } = await loadFixture(deployFixture);
      expect(
        await synthethicMarket.getPendingRewards(alice.address)
      ).to.be.equal(0);
    });

    it('returns the pending rewards', async () => {
      const { synthethicMarket, alice, bob, SYNT } = await loadFixture(
        deployFixture
      );

      await synthethicMarket
        .connect(alice)
        .deposit(alice.address, parseEther('1000'));

      await synthethicMarket
        .connect(alice)
        .mint(alice.address, parseEther('1000'));

      await SYNT.connect(alice).transfer(bob.address, parseEther('100'));

      expect(
        await synthethicMarket.getPendingRewards(alice.address)
      ).to.be.equal(parseEther('9'));

      expect(await synthethicMarket.getPendingRewards(bob.address)).to.be.equal(
        0
      );
    });
  });

  it('accepts deposits', async () => {
    const { synthethicMarket, alice, busd, SYNT, bob } = await loadFixture(
      deployFixture
    );

    const [aliceAccount, totalSynt, totalRewardsPerToken] = await Promise.all([
      synthethicMarket.accountOf(alice.address),
      synthethicMarket.totalSynt(),
      synthethicMarket.totalRewardsPerToken(),
    ]);

    expect(aliceAccount.collateral).to.be.equal(0);
    expect(aliceAccount.synt).to.be.equal(0);
    expect(aliceAccount.rewardDebt).to.be.equal(0);
    expect(totalSynt).to.be.equal(0);
    expect(totalRewardsPerToken).to.be.equal(0);

    await expect(
      synthethicMarket.connect(alice).deposit(alice.address, parseEther('1000'))
    )
      .to.emit(synthethicMarket, 'Deposit')
      .withArgs(alice.address, alice.address, parseEther('1000'))
      .to.emit(busd, 'Transfer')
      .withArgs(alice.address, synthethicMarket.address, parseEther('1000'));

    const [aliceAccount2, totalSynt2, totalRewardsPerToken2] =
      await Promise.all([
        synthethicMarket.accountOf(alice.address),
        synthethicMarket.totalSynt(),
        synthethicMarket.totalRewardsPerToken(),
      ]);

    expect(aliceAccount2.collateral).to.be.equal(parseEther('1000'));
    expect(aliceAccount2.synt).to.be.equal(0);
    expect(aliceAccount2.rewardDebt).to.be.equal(0);
    expect(totalSynt2).to.be.equal(0);
    expect(totalRewardsPerToken2).to.be.equal(0);

    await synthethicMarket
      .connect(alice)
      .mint(alice.address, parseEther('200'));

    await SYNT.connect(alice).transfer(bob.address, parseEther('100'));

    await synthethicMarket.connect(bob).deposit(bob.address, parseEther('500'));

    const [bobAccount3, totalSynt3] = await Promise.all([
      synthethicMarket.accountOf(bob.address),
      synthethicMarket.totalSynt(),
      synthethicMarket.totalRewardsPerToken(),
    ]);

    expect(bobAccount3.synt).to.be.equal(0);
    expect(bobAccount3.collateral).to.be.equal(parseEther('500'));
    expect(bobAccount3.rewardDebt).to.be.equal(0);
    expect(totalSynt3).to.be.equal(parseEther('200'));
  });

  describe('function: withdraw', function () {
    it('reverts if a user withdraws more than he/she is allowed', async () => {
      const { synthethicMarket, alice } = await loadFixture(deployFixture);

      await expect(synthethicMarket.connect(alice).withdraw(alice.address, 1))
        .to.be.reverted;
    });
    it('reverts if the caller is insolvent', async () => {
      const { synthethicMarket, alice } = await loadFixture(deployFixture);

      await synthethicMarket
        .connect(alice)
        .deposit(alice.address, parseEther('1000'));

      await expect(
        synthethicMarket
          .connect(alice)
          .withdraw(alice.address, parseEther('1000').add(1))
      ).to.rejected;

      await synthethicMarket
        .connect(alice)
        .mint(
          alice.address,
          parseEther('1000')
            .mul(MAX_LTV_RATIO)
            .div(parseEther('1'))
            .div(BRL_USD_PRICE)
            .mul(parseEther('1'))
        );

      await expect(
        synthethicMarket
          .connect(alice)
          .withdraw(alice.address, parseEther('20'))
      ).to.be.revertedWithCustomError(
        synthethicMarket,
        'SyntheticMarket__InsolventCaller'
      );
    });

    it('allows withdraws', async () => {
      const { synthethicMarket, alice, bob, busd } = await loadFixture(
        deployFixture
      );

      await synthethicMarket
        .connect(alice)
        .deposit(alice.address, parseEther('1000'));

      await synthethicMarket
        .connect(alice)
        .mint(alice.address, parseEther('100'));

      await expect(
        synthethicMarket.connect(alice).withdraw(bob.address, parseEther('100'))
      )
        .to.emit(synthethicMarket, 'Withdraw')
        .withArgs(alice.address, bob.address, parseEther('100'))
        .to.emit(busd, 'Transfer')
        .withArgs(synthethicMarket.address, bob.address, parseEther('100'));
    });
  });
});
