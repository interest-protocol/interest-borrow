import { anyUint } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { BigNumberish } from 'ethers';
import { ethers } from 'hardhat';

import {
  MintableERC20,
  PriceFeed,
  PriceOracle,
  Swap,
  SyntheticMarket,
  SyntheticMarketV2,
} from '../typechain-types';
import {
  BRL_USD_PRICE,
  deploy,
  deployUUPS,
  upgrade,
  WRAPPED_NATIVE_TOKEN,
} from './utils';

const { parseEther, defaultAbiCoder } = ethers.utils;

const TRANSFER_FEE = parseEther('0.1');

const LIQUIDATION_FEE = parseEther('0.1');

const MAX_LTV_RATIO = parseEther('0.5');

const DEPOSIT_REQUEST = 0;

const WITHDRAW_REQUEST = 1;

const MINT_REQUEST = 2;

const BURN_REQUEST = 3;

const encodeABIData = (address: string, amount: BigNumberish) =>
  defaultAbiCoder.encode(['address', 'uint256'], [address, amount]);

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

  describe('function: mint', function () {
    it('reverts if the user is insolvent', async () => {
      const { synthethicMarket, alice, bob } = await loadFixture(deployFixture);

      await expect(
        synthethicMarket.connect(alice).mint(bob.address, 1)
      ).to.be.revertedWithCustomError(
        synthethicMarket,
        'SyntheticMarket__InsolventCaller'
      );

      await synthethicMarket
        .connect(alice)
        .deposit(alice.address, parseEther('1000'));

      await expect(
        synthethicMarket
          .connect(alice)
          .mint(
            bob.address,
            parseEther('1000').div(BRL_USD_PRICE).mul(parseEther('1')).add(1)
          )
      ).to.be.revertedWithCustomError(
        synthethicMarket,
        'SyntheticMarket__InsolventCaller'
      );
    });

    it('allows users to create synts', async () => {
      const { synthethicMarket, alice, bob, SYNT } = await loadFixture(
        deployFixture
      );

      await Promise.all([
        synthethicMarket
          .connect(alice)
          .deposit(alice.address, parseEther('1000')),
        synthethicMarket.connect(bob).deposit(bob.address, parseEther('1000')),
      ]);

      await expect(
        synthethicMarket.connect(alice).mint(bob.address, parseEther('100'))
      )
        .to.emit(synthethicMarket, 'Mint')
        .withArgs(alice.address, bob.address, parseEther('100'), 0)
        .to.emit(SYNT, 'Transfer')
        .withArgs(ethers.constants.AddressZero, bob.address, parseEther('100'));

      const [aliceAccount, totalSynt, totalRewardsPerToken] = await Promise.all(
        [
          synthethicMarket.accountOf(alice.address),
          synthethicMarket.totalSynt(),
          synthethicMarket.totalRewardsPerToken(),
        ]
      );

      expect(aliceAccount.collateral).to.be.equal(parseEther('1000'));
      expect(aliceAccount.synt).to.be.equal(parseEther('100'));
      expect(aliceAccount.rewardDebt).to.be.equal(0);
      expect(totalSynt).to.be.equal(parseEther('100'));
      expect(totalRewardsPerToken).to.be.equal(0);

      // 10 SYNT FEE
      await SYNT.connect(bob).transfer(alice.address, parseEther('100'));

      await expect(
        synthethicMarket.connect(bob).mint(bob.address, parseEther('50'))
      )
        .to.emit(synthethicMarket, 'Mint')
        .withArgs(bob.address, bob.address, parseEther('50'), 0);

      const [bobAccount2, totalSynt2, totalRewardsPerToken2] =
        await Promise.all([
          synthethicMarket.accountOf(bob.address),
          synthethicMarket.totalSynt(),
          synthethicMarket.totalRewardsPerToken(),
        ]);

      expect(bobAccount2.collateral).to.be.equal(parseEther('1000'));
      expect(bobAccount2.synt).to.be.equal(parseEther('50'));
      expect(bobAccount2.rewardDebt).to.be.equal(
        totalRewardsPerToken2.mul(parseEther('50')).div(parseEther('1'))
      );
      expect(totalSynt2).to.be.equal(parseEther('150'));
      expect(totalRewardsPerToken2).to.be.equal(
        parseEther('9').mul(parseEther('1')).div(parseEther('100'))
      );

      await expect(synthethicMarket.connect(alice).mint(alice.address, 0))
        .to.emit(synthethicMarket, 'Mint')
        .withArgs(alice.address, alice.address, 0, parseEther('9'));

      // 9 Synt Fee
      await SYNT.connect(alice).transfer(bob.address, parseEther('90'));

      await expect(synthethicMarket.connect(alice).mint(alice.address, 0))
        .to.emit(synthethicMarket, 'Mint')
        .withArgs(
          alice.address,
          alice.address,
          0,
          parseEther('9')
            .mul(parseEther('0.9'))
            .div(parseEther('1'))
            .mul(parseEther('100'))
            .div(parseEther('150'))
        );

      await expect(synthethicMarket.connect(bob).mint(alice.address, 0))
        .to.emit(synthethicMarket, 'Mint')
        .withArgs(
          bob.address,
          alice.address,
          0,
          parseEther('9')
            .mul(parseEther('0.9'))
            .div(parseEther('1'))
            .mul(parseEther('50'))
            .div(parseEther('150'))
        );
    });
  });

  describe('function: burn', function () {
    it('reverts if the user does not have enough tokens to burn', async () => {
      const { synthethicMarket, alice } = await loadFixture(deployFixture);

      await synthethicMarket
        .connect(alice)
        .deposit(alice.address, parseEther('1000'));

      await synthethicMarket
        .connect(alice)
        .mint(alice.address, parseEther('100'));

      await expect(
        synthethicMarket
          .connect(alice)
          .burn(alice.address, parseEther('100').add(1))
      ).to.be.reverted;
    });

    it('allows a user to burn', async () => {
      const { synthethicMarket, alice, bob, SYNT } = await loadFixture(
        deployFixture
      );

      await Promise.all([
        synthethicMarket
          .connect(alice)
          .deposit(alice.address, parseEther('1000')),
        synthethicMarket.connect(bob).deposit(bob.address, parseEther('1000')),
      ]);

      await synthethicMarket
        .connect(alice)
        .mint(bob.address, parseEther('100'));

      const [aliceAccount, totalSynt, totalRewardsPerToken] = await Promise.all(
        [
          synthethicMarket.accountOf(alice.address),
          synthethicMarket.totalSynt(),
          synthethicMarket.totalRewardsPerToken(),
        ]
      );

      expect(aliceAccount.collateral).to.be.equal(parseEther('1000'));
      expect(aliceAccount.synt).to.be.equal(parseEther('100'));
      expect(aliceAccount.rewardDebt).to.be.equal(0);
      expect(totalSynt).to.be.equal(parseEther('100'));
      expect(totalRewardsPerToken).to.be.equal(0);

      // 10 SYNT FEE
      await SYNT.connect(bob).transfer(alice.address, parseEther('100'));

      await synthethicMarket.connect(bob).mint(bob.address, parseEther('50'));

      await expect(
        synthethicMarket.connect(alice).burn(alice.address, parseEther('10'))
      )
        .to.emit(synthethicMarket, 'Burn')
        .withArgs(
          alice.address,
          alice.address,
          parseEther('10'),
          parseEther('9')
        );

      const [aliceAccount2, totalSynt2, totalRewardsPerToken2] =
        await Promise.all([
          synthethicMarket.accountOf(alice.address),
          synthethicMarket.totalSynt(),
          synthethicMarket.totalRewardsPerToken(),
        ]);

      expect(aliceAccount2.collateral).to.be.equal(parseEther('1000'));
      expect(aliceAccount2.synt).to.be.equal(parseEther('90'));
      expect(aliceAccount2.rewardDebt).to.be.equal(
        totalRewardsPerToken2.mul(parseEther('90')).div(parseEther('1'))
      );
      expect(totalSynt2).to.be.equal(parseEther('140'));
      expect(totalRewardsPerToken2).to.be.equal(
        parseEther('9').mul(parseEther('1')).div(parseEther('100'))
      );

      // 5 SYNT FEE
      await SYNT.connect(alice).transfer(bob.address, parseEther('50'));

      await expect(
        synthethicMarket.connect(alice).burn(alice.address, parseEther('10'))
      )
        .to.emit(synthethicMarket, 'Burn')
        .withArgs(
          alice.address,
          alice.address,
          parseEther('10'),
          parseEther('5')
            .mul(parseEther('0.9'))
            .div(parseEther('1'))
            .mul(parseEther('1'))
            .div(parseEther('140'))
            .add(totalRewardsPerToken2)
            .mul(parseEther('90'))
            .div(parseEther('1'))
            .sub(aliceAccount2.rewardDebt)
        );

      const [totalRewardsPerToken3, bobAccount3] = await Promise.all([
        synthethicMarket.totalRewardsPerToken(),
        synthethicMarket.accountOf(bob.address),
      ]);

      await expect(
        synthethicMarket.connect(bob).burn(bob.address, parseEther('10'))
      )
        .to.emit(synthethicMarket, 'Burn')
        .withArgs(
          bob.address,
          bob.address,
          parseEther('10'),
          totalRewardsPerToken3
            .mul(parseEther('50'))
            .div(parseEther('1'))
            .sub(bobAccount3.rewardDebt)
        );
    });
  });

  it('allows a user to get his/her rewards', async () => {
    const { synthethicMarket, alice, bob, SYNT } = await loadFixture(
      deployFixture
    );

    await expect(synthethicMarket.connect(alice).getRewards()).to.not.emit(
      SYNT,
      'Transfer'
    );

    await Promise.all([
      synthethicMarket
        .connect(alice)
        .deposit(alice.address, parseEther('1000')),
      synthethicMarket.connect(bob).deposit(bob.address, parseEther('1000')),
    ]);

    await Promise.all([
      synthethicMarket.connect(alice).mint(alice.address, parseEther('100')),
      synthethicMarket.connect(bob).mint(bob.address, parseEther('100')),
    ]);

    await SYNT.connect(alice).transfer(bob.address, parseEther('100'));

    await expect(synthethicMarket.connect(alice).getRewards())
      .to.emit(synthethicMarket, 'GetRewards')
      .withArgs(alice.address, parseEther('4.5'))
      .to.emit(SYNT, 'Transfer')
      .withArgs(synthethicMarket.address, alice.address, parseEther('4.5'));

    const [totalRewardsPerToken, aliceAccount] = await Promise.all([
      synthethicMarket.totalRewardsPerToken(),
      synthethicMarket.accountOf(alice.address),
    ]);

    expect(totalRewardsPerToken).to.be.equal(
      parseEther('9').mul(parseEther('1')).div(parseEther('200'))
    );
    expect(aliceAccount.rewardDebt).to.be.equal(
      totalRewardsPerToken.mul(aliceAccount.synt).div(parseEther('1'))
    );
  });

  describe('function: setTransferFee', function () {
    it('reverts if it is not called by the owner', async () => {
      const { synthethicMarket, alice } = await loadFixture(deployFixture);

      await expect(
        synthethicMarket.connect(alice).setTransferFee(1)
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('updates the transfer fee', async () => {
      const { synthethicMarket, SYNT, owner } = await loadFixture(
        deployFixture
      );

      expect(await SYNT.transferFee()).to.be.equal(TRANSFER_FEE);

      await synthethicMarket.connect(owner).setTransferFee(0);

      expect(await SYNT.transferFee()).to.be.equal(0);
    });
  });

  describe('function: setTreasury', function () {
    it('reverts if it is not called by the owner', async () => {
      const { synthethicMarket, alice } = await loadFixture(deployFixture);

      await expect(
        synthethicMarket.connect(alice).setTreasury(alice.address)
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('updates the treasury', async () => {
      const { synthethicMarket, SYNT, owner, alice, treasury } =
        await loadFixture(deployFixture);

      expect(await SYNT.treasury()).to.be.equal(treasury.address);

      await synthethicMarket.connect(owner).setTransferFee(alice.address);

      expect(await SYNT.transferFee()).to.be.equal(alice.address);
    });
  });

  describe('function: setLiquidationFee', function () {
    it('reverts if it is not called by the ower', async () => {
      const { synthethicMarket, alice } = await loadFixture(deployFixture);

      await expect(
        synthethicMarket.connect(alice).setLiquidationFee(1)
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('reverts if the fee is higher than 20%', async () => {
      const { synthethicMarket, owner } = await loadFixture(deployFixture);

      await expect(
        synthethicMarket
          .connect(owner)
          .setLiquidationFee(parseEther('0.2').add(1))
      ).to.be.revertedWithCustomError(
        synthethicMarket,
        'SyntheticMarket__InvalidFee'
      );
    });

    it('updates the liquidation fee', async () => {
      const { synthethicMarket, owner } = await loadFixture(deployFixture);

      expect(await synthethicMarket.liquidationFee()).to.be.equal(
        LIQUIDATION_FEE
      );

      await expect(
        synthethicMarket.connect(owner).setLiquidationFee(parseEther('0.05'))
      )
        .to.emit(synthethicMarket, 'LiquidationFeeUpdated')
        .withArgs(LIQUIDATION_FEE, parseEther('0.05'));

      expect(await synthethicMarket.liquidationFee()).to.be.equal(
        parseEther('0.05')
      );
    });
  });

  describe('function: setMaxLTVRatio', function () {
    it('reverts if it is not called by the ower', async () => {
      const { synthethicMarket, alice } = await loadFixture(deployFixture);

      await expect(
        synthethicMarket.connect(alice).setMaxLTVRatio(1)
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('reverts if the fee is higher than 90%', async () => {
      const { synthethicMarket, owner } = await loadFixture(deployFixture);

      await expect(
        synthethicMarket.connect(owner).setMaxLTVRatio(parseEther('0.9').add(1))
      ).to.be.revertedWithCustomError(
        synthethicMarket,
        'SyntheticMarket__InvalidFee'
      );
    });

    it('updates the max ltv ratio', async () => {
      const { synthethicMarket, owner } = await loadFixture(deployFixture);

      expect(await synthethicMarket.maxLTVRatio()).to.be.equal(MAX_LTV_RATIO);

      await expect(
        synthethicMarket.connect(owner).setMaxLTVRatio(parseEther('0.8'))
      )
        .to.emit(synthethicMarket, 'MaxLTVRatioUpdated')
        .withArgs(MAX_LTV_RATIO, parseEther('0.8'));

      expect(await synthethicMarket.maxLTVRatio()).to.be.equal(
        parseEther('0.8')
      );
    });
  });

  describe('function: request', function () {
    it('reverts if you pass an invalid request', async () => {
      const { synthethicMarket } = await loadFixture(deployFixture);
      await expect(
        synthethicMarket.request(
          [7],
          [encodeABIData(ethers.constants.AddressZero, 1)]
        )
      ).to.be.revertedWithCustomError(
        synthethicMarket,
        'SyntheticMarket__InvalidRequest'
      );
    });
    it('accepts deposits', async () => {
      const { synthethicMarket, alice, busd, SYNT, bob } = await loadFixture(
        deployFixture
      );

      const [aliceAccount, totalSynt, totalRewardsPerToken] = await Promise.all(
        [
          synthethicMarket.accountOf(alice.address),
          synthethicMarket.totalSynt(),
          synthethicMarket.totalRewardsPerToken(),
        ]
      );

      expect(aliceAccount.collateral).to.be.equal(0);
      expect(aliceAccount.synt).to.be.equal(0);
      expect(aliceAccount.rewardDebt).to.be.equal(0);
      expect(totalSynt).to.be.equal(0);
      expect(totalRewardsPerToken).to.be.equal(0);

      await expect(
        synthethicMarket
          .connect(alice)
          .request(
            [DEPOSIT_REQUEST],
            [encodeABIData(alice.address, parseEther('1000'))]
          )
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

      await synthethicMarket
        .connect(bob)
        .request(
          [DEPOSIT_REQUEST],
          [encodeABIData(bob.address, parseEther('500'))]
        );

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

    describe('request: withdraw', function () {
      it('reverts if a user withdraws more than he/she is allowed', async () => {
        const { synthethicMarket, alice } = await loadFixture(deployFixture);

        await expect(
          synthethicMarket
            .connect(alice)
            .request([WITHDRAW_REQUEST], [encodeABIData(alice.address, 1)])
        ).to.be.reverted;
      });
      it('reverts if the caller is insolvent', async () => {
        const { synthethicMarket, alice } = await loadFixture(deployFixture);

        await expect(
          synthethicMarket
            .connect(alice)
            .request(
              [DEPOSIT_REQUEST, WITHDRAW_REQUEST],
              [
                encodeABIData(alice.address, parseEther('1000')),
                encodeABIData(alice.address, parseEther('1000').add(1)),
              ]
            )
        ).to.be.reverted;

        await expect(
          synthethicMarket
            .connect(alice)
            .request(
              [DEPOSIT_REQUEST, MINT_REQUEST, WITHDRAW_REQUEST],
              [
                encodeABIData(alice.address, parseEther('1000')),
                encodeABIData(
                  alice.address,
                  parseEther('1000')
                    .mul(MAX_LTV_RATIO)
                    .div(parseEther('1'))
                    .div(BRL_USD_PRICE)
                    .mul(parseEther('1'))
                ),
                encodeABIData(alice.address, parseEther('20')),
              ]
            )
        ).to.be.revertedWithCustomError(
          synthethicMarket,
          'SyntheticMarket__InsolventCaller'
        );
      });

      it('allows withdraws', async () => {
        const { synthethicMarket, alice, bob, busd } = await loadFixture(
          deployFixture
        );

        await expect(
          synthethicMarket
            .connect(alice)
            .request(
              [DEPOSIT_REQUEST, MINT_REQUEST, WITHDRAW_REQUEST],
              [
                encodeABIData(alice.address, parseEther('1000')),
                encodeABIData(alice.address, parseEther('100')),
                encodeABIData(bob.address, parseEther('100')),
              ]
            )
        )
          .to.emit(synthethicMarket, 'Withdraw')
          .withArgs(alice.address, bob.address, parseEther('100'))
          .to.emit(busd, 'Transfer')
          .withArgs(synthethicMarket.address, bob.address, parseEther('100'));
      });
    });

    describe('request: mint', function () {
      it('reverts if the user is insolvent', async () => {
        const { synthethicMarket, alice, bob } = await loadFixture(
          deployFixture
        );

        await expect(
          synthethicMarket
            .connect(alice)
            .request([MINT_REQUEST], [encodeABIData(bob.address, 1)])
        ).to.be.revertedWithCustomError(
          synthethicMarket,
          'SyntheticMarket__InsolventCaller'
        );

        await expect(
          synthethicMarket
            .connect(alice)
            .request(
              [DEPOSIT_REQUEST, MINT_REQUEST],
              [
                encodeABIData(alice.address, parseEther('1000')),
                encodeABIData(
                  bob.address,
                  parseEther('1000')
                    .div(BRL_USD_PRICE)
                    .mul(parseEther('1'))
                    .add(1)
                ),
              ]
            )
        ).to.be.revertedWithCustomError(
          synthethicMarket,
          'SyntheticMarket__InsolventCaller'
        );
      });

      it('allows users to create synts', async () => {
        const { synthethicMarket, alice, bob, SYNT } = await loadFixture(
          deployFixture
        );

        await Promise.all([
          synthethicMarket
            .connect(alice)
            .deposit(alice.address, parseEther('1000')),
          synthethicMarket
            .connect(bob)
            .deposit(bob.address, parseEther('1000')),
        ]);

        await expect(
          synthethicMarket
            .connect(alice)
            .request(
              [MINT_REQUEST],
              [encodeABIData(bob.address, parseEther('100'))]
            )
        )
          .to.emit(synthethicMarket, 'Mint')
          .withArgs(alice.address, bob.address, parseEther('100'), 0)
          .to.emit(SYNT, 'Transfer')
          .withArgs(
            ethers.constants.AddressZero,
            bob.address,
            parseEther('100')
          );

        const [aliceAccount, totalSynt, totalRewardsPerToken] =
          await Promise.all([
            synthethicMarket.accountOf(alice.address),
            synthethicMarket.totalSynt(),
            synthethicMarket.totalRewardsPerToken(),
          ]);

        expect(aliceAccount.collateral).to.be.equal(parseEther('1000'));
        expect(aliceAccount.synt).to.be.equal(parseEther('100'));
        expect(aliceAccount.rewardDebt).to.be.equal(0);
        expect(totalSynt).to.be.equal(parseEther('100'));
        expect(totalRewardsPerToken).to.be.equal(0);

        // 10 SYNT FEE
        await SYNT.connect(bob).transfer(alice.address, parseEther('100'));

        await expect(
          synthethicMarket
            .connect(bob)
            .request(
              [MINT_REQUEST],
              [encodeABIData(bob.address, parseEther('50'))]
            )
        )
          .to.emit(synthethicMarket, 'Mint')
          .withArgs(bob.address, bob.address, parseEther('50'), 0);

        const [bobAccount2, totalSynt2, totalRewardsPerToken2] =
          await Promise.all([
            synthethicMarket.accountOf(bob.address),
            synthethicMarket.totalSynt(),
            synthethicMarket.totalRewardsPerToken(),
          ]);

        expect(bobAccount2.collateral).to.be.equal(parseEther('1000'));
        expect(bobAccount2.synt).to.be.equal(parseEther('50'));
        expect(bobAccount2.rewardDebt).to.be.equal(
          totalRewardsPerToken2.mul(parseEther('50')).div(parseEther('1'))
        );
        expect(totalSynt2).to.be.equal(parseEther('150'));
        expect(totalRewardsPerToken2).to.be.equal(
          parseEther('9').mul(parseEther('1')).div(parseEther('100'))
        );

        await expect(
          synthethicMarket
            .connect(alice)
            .request([MINT_REQUEST], [encodeABIData(alice.address, 0)])
        )
          .to.emit(synthethicMarket, 'Mint')
          .withArgs(alice.address, alice.address, 0, parseEther('9'));

        // 9 Synt Fee
        await SYNT.connect(alice).transfer(bob.address, parseEther('90'));

        await expect(
          synthethicMarket
            .connect(alice)
            .request([MINT_REQUEST], [encodeABIData(alice.address, 0)])
        )
          .to.emit(synthethicMarket, 'Mint')
          .withArgs(
            alice.address,
            alice.address,
            0,
            parseEther('9')
              .mul(parseEther('0.9'))
              .div(parseEther('1'))
              .mul(parseEther('100'))
              .div(parseEther('150'))
          );

        await expect(
          synthethicMarket
            .connect(bob)
            .request([MINT_REQUEST], [encodeABIData(alice.address, 0)])
        )
          .to.emit(synthethicMarket, 'Mint')
          .withArgs(
            bob.address,
            alice.address,
            0,
            parseEther('9')
              .mul(parseEther('0.9'))
              .div(parseEther('1'))
              .mul(parseEther('50'))
              .div(parseEther('150'))
          );
      });
    });

    describe('request: burn', function () {
      it('reverts if the user does not have enough tokens to burn', async () => {
        const { synthethicMarket, alice } = await loadFixture(deployFixture);

        await expect(
          synthethicMarket
            .connect(alice)
            .request(
              [DEPOSIT_REQUEST, MINT_REQUEST, BURN_REQUEST],
              [
                encodeABIData(alice.address, parseEther('1000')),
                encodeABIData(alice.address, parseEther('100')),
                encodeABIData(alice.address, parseEther('100').add(1)),
              ]
            )
        ).to.be.reverted;
      });

      it('allows a user to burn', async () => {
        const { synthethicMarket, alice, bob, SYNT } = await loadFixture(
          deployFixture
        );

        await Promise.all([
          synthethicMarket
            .connect(alice)
            .deposit(alice.address, parseEther('1000')),
          synthethicMarket
            .connect(bob)
            .deposit(bob.address, parseEther('1000')),
        ]);

        await synthethicMarket
          .connect(alice)
          .request(
            [MINT_REQUEST],
            [encodeABIData(bob.address, parseEther('100'))]
          );

        const [aliceAccount, totalSynt, totalRewardsPerToken] =
          await Promise.all([
            synthethicMarket.accountOf(alice.address),
            synthethicMarket.totalSynt(),
            synthethicMarket.totalRewardsPerToken(),
          ]);

        expect(aliceAccount.collateral).to.be.equal(parseEther('1000'));
        expect(aliceAccount.synt).to.be.equal(parseEther('100'));
        expect(aliceAccount.rewardDebt).to.be.equal(0);
        expect(totalSynt).to.be.equal(parseEther('100'));
        expect(totalRewardsPerToken).to.be.equal(0);

        // 10 SYNT FEE
        await SYNT.connect(bob).transfer(alice.address, parseEther('100'));

        await synthethicMarket.connect(bob).mint(bob.address, parseEther('50'));

        await expect(
          synthethicMarket
            .connect(alice)
            .request(
              [BURN_REQUEST],
              [encodeABIData(alice.address, parseEther('10'))]
            )
        )
          .to.emit(synthethicMarket, 'Burn')
          .withArgs(
            alice.address,
            alice.address,
            parseEther('10'),
            parseEther('9')
          );

        const [aliceAccount2, totalSynt2, totalRewardsPerToken2] =
          await Promise.all([
            synthethicMarket.accountOf(alice.address),
            synthethicMarket.totalSynt(),
            synthethicMarket.totalRewardsPerToken(),
          ]);

        expect(aliceAccount2.collateral).to.be.equal(parseEther('1000'));
        expect(aliceAccount2.synt).to.be.equal(parseEther('90'));
        expect(aliceAccount2.rewardDebt).to.be.equal(
          totalRewardsPerToken2.mul(parseEther('90')).div(parseEther('1'))
        );
        expect(totalSynt2).to.be.equal(parseEther('140'));
        expect(totalRewardsPerToken2).to.be.equal(
          parseEther('9').mul(parseEther('1')).div(parseEther('100'))
        );

        // 5 SYNT FEE
        await SYNT.connect(alice).transfer(bob.address, parseEther('50'));

        await expect(
          synthethicMarket
            .connect(alice)
            .request(
              [BURN_REQUEST],
              [encodeABIData(alice.address, parseEther('10'))]
            )
        )
          .to.emit(synthethicMarket, 'Burn')
          .withArgs(
            alice.address,
            alice.address,
            parseEther('10'),
            parseEther('5')
              .mul(parseEther('0.9'))
              .div(parseEther('1'))
              .mul(parseEther('1'))
              .div(parseEther('140'))
              .add(totalRewardsPerToken2)
              .mul(parseEther('90'))
              .div(parseEther('1'))
              .sub(aliceAccount2.rewardDebt)
          );

        const [totalRewardsPerToken3, bobAccount3] = await Promise.all([
          synthethicMarket.totalRewardsPerToken(),
          synthethicMarket.accountOf(bob.address),
        ]);

        await expect(
          synthethicMarket
            .connect(bob)
            .request(
              [BURN_REQUEST],
              [encodeABIData(bob.address, parseEther('10'))]
            )
        )
          .to.emit(synthethicMarket, 'Burn')
          .withArgs(
            bob.address,
            bob.address,
            parseEther('10'),
            totalRewardsPerToken3
              .mul(parseEther('50'))
              .div(parseEther('1'))
              .sub(bobAccount3.rewardDebt)
          );
      });
    });
  });

  describe('function: liquidate', function () {
    it('reverts if there are no under water positions', async () => {
      const { synthethicMarket, alice, bob } = await loadFixture(deployFixture);

      await Promise.all([
        synthethicMarket
          .connect(alice)
          .request(
            [DEPOSIT_REQUEST, MINT_REQUEST],
            [
              encodeABIData(alice.address, parseEther('1000')),
              encodeABIData(alice.address, parseEther('1000')),
            ]
          ),
        synthethicMarket
          .connect(bob)
          .request(
            [DEPOSIT_REQUEST, MINT_REQUEST],
            [
              encodeABIData(bob.address, parseEther('1000')),
              encodeABIData(bob.address, parseEther('1000')),
            ]
          ),
      ]);

      await expect(
        synthethicMarket
          .connect(alice)
          .liquidate(
            [alice.address, bob.address],
            [parseEther('1000'), parseEther('1000')],
            alice.address,
            []
          )
      ).to.be.revertedWithCustomError(
        synthethicMarket,
        'SyntheticMarket__InvalidLiquidationAmount'
      );
    });

    it('liquidates a user without calling the Swap contract', async () => {
      const {
        synthethicMarket,
        owner,
        alice,
        bob,
        jose,
        priceFeed,
        busd,
        SYNT,
      } = await loadFixture(deployFixture);

      await Promise.all([
        busd.mint(owner.address, parseEther('1000000')),
        busd.approve(synthethicMarket.address, ethers.constants.MaxUint256),
      ]);

      await Promise.all([
        synthethicMarket
          .connect(alice)
          .request(
            [DEPOSIT_REQUEST, MINT_REQUEST],
            [
              encodeABIData(alice.address, parseEther('1000')),
              encodeABIData(alice.address, parseEther('2500')),
            ]
          ),
        synthethicMarket
          .connect(bob)
          .request(
            [DEPOSIT_REQUEST, MINT_REQUEST],
            [
              encodeABIData(bob.address, parseEther('1000')),
              encodeABIData(bob.address, parseEther('2000')),
            ]
          ),
        synthethicMarket
          .connect(jose)
          .request(
            [DEPOSIT_REQUEST, MINT_REQUEST],
            [
              encodeABIData(jose.address, parseEther('1000')),
              encodeABIData(jose.address, parseEther('900')),
            ]
          ),
        synthethicMarket.request(
          [DEPOSIT_REQUEST, MINT_REQUEST],
          [
            encodeABIData(owner.address, parseEther('100000')),
            encodeABIData(owner.address, parseEther('5000')),
          ]
        ),
      ]);

      await priceFeed.setPrice(
        parseEther('0.3').div(ethers.BigNumber.from('10000000000'))
      );

      // 100 rewards fee
      await SYNT.connect(alice).transfer(owner.address, parseEther('1000'));

      await expect(
        synthethicMarket.liquidate(
          [alice.address, bob.address, jose.address],
          [ethers.constants.MaxUint256, parseEther('1000'), parseEther('900')],
          owner.address,
          []
        )
      )
        .to.emit(synthethicMarket, 'Liquidate')
        .withArgs(
          owner.address,
          alice.address,
          parseEther('2500'),
          parseEther('2500')
            .mul(parseEther('0.3'))
            .div(parseEther('1'))
            .mul(parseEther('1').add(LIQUIDATION_FEE))
            .div(parseEther('1'))
        )
        .to.emit(synthethicMarket, 'Liquidate')
        .withArgs(
          owner.address,
          bob.address,
          parseEther('1000'),
          parseEther('1000')
            .mul(parseEther('0.3'))
            .div(parseEther('1'))
            .mul(parseEther('1').add(LIQUIDATION_FEE))
            .div(parseEther('1'))
        )
        .to.emit(SYNT, 'Transfer')
        .withArgs(
          owner.address,
          ethers.constants.AddressZero,
          parseEther('3500')
        )
        .to.emit(SYNT, 'Transfer')
        .withArgs(synthethicMarket.address, alice.address, anyUint)
        .to.emit(SYNT, 'Transfer')
        .withArgs(synthethicMarket.address, bob.address, anyUint);

      const [
        totalSynt,
        totalRewardsPerToken,
        aliceAccount,
        bobAccount,
        joseAccount,
      ] = await Promise.all([
        synthethicMarket.totalSynt(),
        synthethicMarket.totalRewardsPerToken(),
        synthethicMarket.accountOf(alice.address),
        synthethicMarket.accountOf(bob.address),
        synthethicMarket.accountOf(jose.address),
      ]);

      expect(totalSynt).to.be.equal(parseEther('6900'));
      expect(totalRewardsPerToken).to.be.equal(
        parseEther('90').mul(parseEther('1')).div(parseEther('10400'))
      );
      expect(aliceAccount.synt).to.be.equal(0);
      expect(aliceAccount.collateral).to.be.equal(
        parseEther('1000').sub(
          parseEther('2500')
            .mul(parseEther('0.3'))
            .div(parseEther('1'))
            .mul(parseEther('1').add(LIQUIDATION_FEE))
            .div(parseEther('1'))
        )
      );
      expect(aliceAccount.rewardDebt).to.be.equal(0);

      expect(bobAccount.synt).to.be.equal(parseEther('1000'));
      expect(bobAccount.collateral).to.be.equal(
        parseEther('1000').sub(
          parseEther('1000')
            .mul(parseEther('0.3'))
            .div(parseEther('1'))
            .mul(parseEther('1').add(LIQUIDATION_FEE))
            .div(parseEther('1'))
        )
      );
      expect(bobAccount.rewardDebt).to.be.equal(
        totalRewardsPerToken.mul(bobAccount.synt).div(parseEther('1'))
      );

      expect(joseAccount.synt).to.be.equal(parseEther('900'));
      expect(joseAccount.collateral).to.be.equal(parseEther('1000'));
      expect(joseAccount.rewardDebt).to.be.equal(0);
    });

    it('calls the swap contract', async () => {
      const {
        synthethicMarket,
        owner,
        alice,
        bob,
        jose,
        priceFeed,
        busd,
        SYNT,
      } = await loadFixture(deployFixture);

      await Promise.all([
        busd.mint(owner.address, parseEther('1000000')),
        busd.approve(synthethicMarket.address, ethers.constants.MaxUint256),
      ]);

      await Promise.all([
        synthethicMarket
          .connect(alice)
          .request(
            [DEPOSIT_REQUEST, MINT_REQUEST],
            [
              encodeABIData(alice.address, parseEther('1000')),
              encodeABIData(alice.address, parseEther('2500')),
            ]
          ),
        synthethicMarket
          .connect(bob)
          .request(
            [DEPOSIT_REQUEST, MINT_REQUEST],
            [
              encodeABIData(bob.address, parseEther('1000')),
              encodeABIData(bob.address, parseEther('2000')),
            ]
          ),
        synthethicMarket
          .connect(jose)
          .request(
            [DEPOSIT_REQUEST, MINT_REQUEST],
            [
              encodeABIData(jose.address, parseEther('1000')),
              encodeABIData(jose.address, parseEther('900')),
            ]
          ),
        synthethicMarket.request(
          [DEPOSIT_REQUEST, MINT_REQUEST],
          [
            encodeABIData(owner.address, parseEther('100000')),
            encodeABIData(owner.address, parseEther('5000')),
          ]
        ),
      ]);

      await priceFeed.setPrice(
        parseEther('0.3').div(ethers.BigNumber.from('10000000000'))
      );

      // 100 rewards fee
      await SYNT.connect(alice).transfer(owner.address, parseEther('1000'));

      const swap: Swap = await deploy('Swap', []);

      await expect(
        synthethicMarket.liquidate(
          [alice.address, bob.address, jose.address],
          [ethers.constants.MaxUint256, parseEther('1000'), parseEther('900')],
          swap.address,
          ethers.constants.HashZero
        )
      )
        .to.emit(synthethicMarket, 'Liquidate')
        .withArgs(
          owner.address,
          alice.address,
          parseEther('2500'),
          parseEther('2500')
            .mul(parseEther('0.3'))
            .div(parseEther('1'))
            .mul(parseEther('1').add(LIQUIDATION_FEE))
            .div(parseEther('1'))
        )
        .to.emit(synthethicMarket, 'Liquidate')
        .withArgs(
          owner.address,
          bob.address,
          parseEther('1000'),
          parseEther('1000')
            .mul(parseEther('0.3'))
            .div(parseEther('1'))
            .mul(parseEther('1').add(LIQUIDATION_FEE))
            .div(parseEther('1'))
        )
        .to.emit(SYNT, 'Transfer')
        .withArgs(
          owner.address,
          ethers.constants.AddressZero,
          parseEther('3500')
        )
        .to.emit(SYNT, 'Transfer')
        .withArgs(synthethicMarket.address, alice.address, anyUint)
        .to.emit(SYNT, 'Transfer')
        .withArgs(synthethicMarket.address, bob.address, anyUint)
        .to.emit(swap, 'SellOneToken')
        .to.emit(busd, 'Transfer')
        .withArgs(
          synthethicMarket.address,
          swap.address,
          parseEther('3500')
            .mul(parseEther('0.3'))
            .div(parseEther('1'))
            .mul(parseEther('1').add(LIQUIDATION_FEE))
            .div(parseEther('1'))
        );
    });
  });

  describe('Upgrade functionality', function () {
    it('reverts if it is not upgraded by the owner', async () => {
      const { synthethicMarket } = await loadFixture(deployFixture);

      await synthethicMarket.renounceOwnership();

      await expect(
        upgrade(synthethicMarket, 'SyntheticMarketV2')
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('upgrades to version 2', async () => {
      const { synthethicMarket, alice } = await loadFixture(deployFixture);

      await synthethicMarket
        .connect(alice)
        .deposit(alice.address, parseEther('10'));

      expect(
        (await synthethicMarket.accountOf(alice.address)).collateral
      ).to.be.equal(parseEther('10'));

      const synthethicMarketV2: SyntheticMarketV2 = await upgrade(
        synthethicMarket,
        'SyntheticMarketV2'
      );

      const [version, aliceAccount] = await Promise.all([
        synthethicMarketV2.version(),
        synthethicMarketV2.accountOf(alice.address),
      ]);

      expect(version).to.be.equal('v2');
      expect(aliceAccount.collateral).to.be.equal(parseEther('10'));
    });
  });
});
