import { anyUint } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import {
  loadFixture,
  mine,
  time,
} from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers, network } from 'hardhat';

import {
  Dinero,
  NativeTokenMarketDepositReentrancy,
  NativeTokenMarketWithdrawReentrancy,
  PriceFeed,
  PriceOracle,
  Swap,
  TestNativeTokenMarket,
} from '../typechain-types';
import {
  BNB_USD_PRICE_FEED,
  BORROW_REQUEST,
  deploy,
  deployUUPS,
  DEPOSIT_REQUEST,
  MINTER_ROLE,
  REPAY_REQUEST,
  upgrade,
  WITHDRAW_REQUEST,
  WRAPPED_NATIVE_TOKEN,
} from './utils';

const { parseEther, defaultAbiCoder } = ethers.utils;

const INTEREST_RATE = ethers.BigNumber.from(12e8);

const ONE_MONTH_IN_SECONDS = 2.628e6;

const LIQUIDATION_FEE = parseEther('0.1');

const MAX_LTV_RATIO = parseEther('0.5');

const MAX_BORROW_AMOUNT = parseEther('1000000');

const BNB_USD_PRICE = ethers.BigNumber.from('417349361890000000000');

async function deployFixture() {
  const [owner, alice, bob, treasury, jose] = await ethers.getSigners();

  const dinero: Dinero = await deployUUPS('Dinero', []);

  const priceOracle: PriceOracle = await deployUUPS('PriceOracle', [
    WRAPPED_NATIVE_TOKEN,
  ]);

  const contractData = defaultAbiCoder.encode(
    ['address', 'address', 'address'],
    [dinero.address, priceOracle.address, treasury.address]
  );

  const settingsData = defaultAbiCoder.encode(
    ['uint128', 'uint96', 'uint128', 'uint64'],
    [MAX_LTV_RATIO, LIQUIDATION_FEE, parseEther('1000000'), INTEREST_RATE]
  );

  const nativeTokenMarket: TestNativeTokenMarket = await deployUUPS(
    'TestNativeTokenMarket',
    [contractData, settingsData]
  );

  await Promise.all([
    priceOracle.setUSDFeed(WRAPPED_NATIVE_TOKEN, BNB_USD_PRICE_FEED),
    dinero.grantRole(MINTER_ROLE, nativeTokenMarket.address),
    dinero.grantRole(MINTER_ROLE, owner.address),
  ]);

  await dinero.mint(owner.address, parseEther('1000000'));

  return {
    dinero,
    alice,
    owner,
    bob,
    treasury,
    priceOracle,
    nativeTokenMarket,
    jose,
  };
}

describe('Native Token Market', function () {
  describe('function: initialize', function () {
    it('initializes the contract correctly', async () => {
      const { nativeTokenMarket, dinero, priceOracle, treasury } =
        await loadFixture(deployFixture);

      const data = await nativeTokenMarket.metadata();

      expect(data[0]).to.be.equal(dinero.address);
      expect(data[1]).to.be.equal(priceOracle.address);
      expect(data[2]).to.be.equal(treasury.address);
      expect(data[3]).to.be.equal(MAX_LTV_RATIO);
      expect(data[4]).to.be.equal(LIQUIDATION_FEE);
      expect(data[5]).to.be.equal(MAX_BORROW_AMOUNT);
      expect(data[6].interestRate).to.be.equal(INTEREST_RATE);
    });

    it('reverts if you try to initialize the contract again', async () => {
      const { nativeTokenMarket } = await loadFixture(deployFixture);

      await expect(
        nativeTokenMarket.initialize(
          ethers.constants.HashZero,
          ethers.constants.HashZero
        )
      ).to.revertedWith('Initializable: contract is already initialized');
    });
  });

  describe('function: getDineroEarnings', function () {
    it('does not call accrue nor Dinero mint if there is no open loans', async () => {
      const { nativeTokenMarket, dinero } = await loadFixture(deployFixture);

      expect((await nativeTokenMarket.loanTerms()).dnrEarned).to.be.equal(0);

      await expect(nativeTokenMarket.getDineroEarnings())
        .to.not.emit(nativeTokenMarket, 'Accrue')
        .to.not.emit(dinero, 'Transfer');
    });

    it('collects the dnr earnings', async () => {
      const { nativeTokenMarket, dinero, treasury, alice } = await loadFixture(
        deployFixture
      );

      expect(await dinero.balanceOf(treasury.address)).to.be.equal(0);

      await alice.sendTransaction({
        to: nativeTokenMarket.address,
        value: parseEther('10'),
      });

      await nativeTokenMarket
        .connect(alice)
        .borrow(alice.address, parseEther('100'));

      await time.increase(ONE_MONTH_IN_SECONDS);

      await expect(nativeTokenMarket.getDineroEarnings())
        .to.emit(nativeTokenMarket, 'Accrue')
        .to.emit(dinero, 'Transfer')
        .withArgs(ethers.constants.AddressZero, treasury.address, anyUint)
        .to.emit(nativeTokenMarket, 'GetDineroEarnings')
        .withArgs(treasury.address, anyUint);

      const loanTerms = await nativeTokenMarket.loanTerms();
      const currentBlockNumber = await ethers.provider.getBlockNumber();

      expect(loanTerms.dnrEarned).to.be.equal(0);
      expect(loanTerms.lastAccrued.gte(currentBlockNumber)).to.be.equal(true);
    });
  });

  describe('function: getCollateralEarnings', function () {
    it('does not send any collateral if there are no earnings', async () => {
      const { nativeTokenMarket } = await loadFixture(deployFixture);

      await expect(nativeTokenMarket.getCollateralEarnings()).to.not.emit(
        nativeTokenMarket,
        'GetCollateralEarnings'
      );

      expect(
        (await nativeTokenMarket.loanTerms()).collateralEarned
      ).to.be.equal(0);
    });

    it('sends the collateral earnings to the treasury', async () => {
      const { nativeTokenMarket, alice, treasury } = await loadFixture(
        deployFixture
      );

      await Promise.all([
        alice.sendTransaction({
          to: nativeTokenMarket.address,
          value: parseEther('2'),
        }),
        nativeTokenMarket.setCollateralEarnings(parseEther('1')),
      ]);

      const treasuryBalance = await treasury.getBalance();

      expect(
        (await nativeTokenMarket.loanTerms()).collateralEarned
      ).to.be.equal(parseEther('1'));

      await expect(nativeTokenMarket.getCollateralEarnings())
        .to.emit(nativeTokenMarket, 'GetCollateralEarnings')
        .withArgs(treasury.address, parseEther('1'));

      expect(
        (await nativeTokenMarket.loanTerms()).collateralEarned
      ).to.be.equal(0);

      expect(await treasury.getBalance()).to.be.equal(
        treasuryBalance.add(parseEther('1'))
      );
    });
  });

  describe('function: accrue', function () {
    it('it does not accrue if there are no loans', async () => {
      const { nativeTokenMarket } = await loadFixture(deployFixture);

      const lastAccrued = (await nativeTokenMarket.loanTerms()).lastAccrued;
      const loan = await nativeTokenMarket.loan();

      await expect(nativeTokenMarket.accrue()).to.not.emit(
        nativeTokenMarket,
        'Accrue'
      );

      await time.increase(1000);

      await nativeTokenMarket.accrue();

      const loan2 = await nativeTokenMarket.loan();

      expect(
        (await nativeTokenMarket.loanTerms()).lastAccrued.gt(lastAccrued)
      ).to.be.equal(true);
      expect(loan.base).to.be.equal(loan2.base);
      expect(loan.elastic).to.be.equal(loan2.elastic);
    });

    it('it does not accrue if there is no interest rate', async () => {
      const { nativeTokenMarket, alice } = await loadFixture(deployFixture);

      const lastAccrued = (await nativeTokenMarket.loanTerms()).lastAccrued;
      const loan = await nativeTokenMarket.loan();
      await nativeTokenMarket.setInterestRate(0);
      await alice.sendTransaction({
        to: nativeTokenMarket.address,
        value: parseEther('10'),
      });

      await time.increase(1000);

      await expect(nativeTokenMarket.accrue()).to.not.emit(
        nativeTokenMarket,
        'Accrue'
      );

      const loan2 = await nativeTokenMarket.loan();

      expect(
        (await nativeTokenMarket.loanTerms()).lastAccrued.gt(lastAccrued)
      ).to.be.equal(true);
      expect(loan.base).to.be.equal(loan2.base);
      expect(loan.elastic).to.be.equal(loan2.elastic);
    });

    it('does not accrue if it is called within the same block', async () => {
      const { nativeTokenMarket, alice } = await loadFixture(deployFixture);

      await alice.sendTransaction({
        to: nativeTokenMarket.address,
        value: parseEther('10'),
      });
      await nativeTokenMarket
        .connect(alice)
        .borrow(alice.address, parseEther('1000'));

      await time.increase(ONE_MONTH_IN_SECONDS);

      await network.provider.send('evm_setAutomine', [false]);

      const firstAccrueTX = await nativeTokenMarket.accrue();

      const secondAccrueTX = await nativeTokenMarket.accrue();

      await mine(1);

      await network.provider.send('evm_setAutomine', [true]);

      await firstAccrueTX.wait(1);
      await secondAccrueTX.wait(1);

      // No event is emitted on first Stake
      // Only the second TX emitted an updatePool
      // Third Stake on the same block as the second one. So no event was emitted.
      expect(
        (
          await nativeTokenMarket.queryFilter(
            nativeTokenMarket.filters.Accrue(null),
            15_018_612
          )
        ).length
      ).to.be.equal(1);
    });

    it('properly updates the debt accumulated by the protocol', async () => {
      const { nativeTokenMarket, alice } = await loadFixture(deployFixture);

      await alice.sendTransaction({
        to: nativeTokenMarket.address,
        value: parseEther('10'),
      });

      await network.provider.send('evm_setAutomine', [false]);

      await nativeTokenMarket
        .connect(alice)
        .borrow(alice.address, parseEther('1000'));

      await mine(1);

      const loan = await nativeTokenMarket.loan();

      await time.increase(ONE_MONTH_IN_SECONDS);

      const accrueTX = await nativeTokenMarket.accrue();

      await mine(1);

      await accrueTX.wait(1);
      const loan2 = await nativeTokenMarket.loan();

      expect(loan.base).to.be.equal(loan2.base);
      expect(
        loan.elastic.add(
          loan.elastic
            .mul(INTEREST_RATE)
            .mul(ONE_MONTH_IN_SECONDS)
            .div(parseEther('1'))
        )
      ).to.be.closeTo(loan2.elastic, parseEther('0.001'));

      await network.provider.send('evm_setAutomine', [true]);
    });
  });

  describe('function: deposit(address)', function () {
    it('reverts on amount or address 0', async () => {
      const { nativeTokenMarket, alice } = await loadFixture(deployFixture);

      await expect(
        nativeTokenMarket
          .connect(alice)
          .deposit(ethers.constants.AddressZero, { value: 1 })
      ).to.rejectedWith('NativeTokenMarket__InvalidAddress()');
      await expect(
        nativeTokenMarket.connect(alice).deposit(alice.address, { value: 0 })
      ).to.rejectedWith('NativeTokenMarket__InvalidAmount()');
    });

    it('accepts deposits', async () => {
      const { nativeTokenMarket, alice, owner } = await loadFixture(
        deployFixture
      );

      await expect(
        nativeTokenMarket
          .connect(alice)
          .deposit(owner.address, { value: parseEther('10') })
      )
        .to.emit(nativeTokenMarket, 'Deposit')
        .withArgs(alice.address, owner.address, parseEther('10'));

      const aliceAccount = await nativeTokenMarket.userAccount(alice.address);
      const ownerAccount = await nativeTokenMarket.userAccount(owner.address);

      expect(aliceAccount.collateral).to.be.equal(0);
      expect(ownerAccount.collateral).to.be.equal(parseEther('10'));

      await nativeTokenMarket.borrow(owner.address, parseEther('100'));

      await time.increase(1000);

      await expect(
        nativeTokenMarket
          .connect(alice)
          .deposit(owner.address, { value: parseEther('10') })
      ).to.not.emit(nativeTokenMarket, 'Accrue');
    });

    it('reverts on reentrancy', async () => {
      const { nativeTokenMarket, alice } = await loadFixture(deployFixture);

      const attacker: NativeTokenMarketDepositReentrancy = await deploy(
        'NativeTokenMarketDepositReentrancy',
        [nativeTokenMarket.address]
      );

      await alice.sendTransaction({
        to: nativeTokenMarket.address,
        value: parseEther('1'),
      });

      await expect(
        nativeTokenMarket.connect(alice).withdraw(attacker.address, 1)
      ).to.rejectedWith('NativeTokenTransferFailed()');
    });
  });

  describe('function: withdraw(address, uint256)', function () {
    it('reverts on 0 amount withdraws', async () => {
      const { nativeTokenMarket, alice } = await loadFixture(deployFixture);

      await expect(
        nativeTokenMarket.withdraw(alice.address, 0)
      ).to.rejectedWith('NativeTokenMarket__InvalidAmount()');
    });

    it('allows solvent users to withdraw', async () => {
      const { nativeTokenMarket, alice, owner } = await loadFixture(
        deployFixture
      );

      await alice.sendTransaction({
        to: nativeTokenMarket.address,
        value: parseEther('10'),
      });

      const ownerBalance = await owner.getBalance();

      await nativeTokenMarket
        .connect(alice)
        .borrow(alice.address, parseEther('1000'));

      await time.increase(1000);

      await expect(
        nativeTokenMarket
          .connect(alice)
          .withdraw(owner.address, parseEther('2'))
      )
        .to.emit(nativeTokenMarket, 'Accrue')
        .to.emit(nativeTokenMarket, 'Withdraw')
        .withArgs(alice.address, owner.address, parseEther('2'));

      expect(
        (await nativeTokenMarket.userAccount(alice.address)).collateral
      ).to.be.equal(parseEther('8'));

      expect(await owner.getBalance()).to.be.equal(
        ownerBalance.add(parseEther('2'))
      );
    });

    it('does not allow insolvent users to withdraw', async () => {
      const { nativeTokenMarket, alice, priceOracle } = await loadFixture(
        deployFixture
      );

      const priceFeed: PriceFeed = await deploy('PriceFeed');

      await alice.sendTransaction({
        to: nativeTokenMarket.address,
        value: parseEther('10'),
      });

      await nativeTokenMarket
        .connect(alice)
        .borrow(
          alice.address,
          MAX_LTV_RATIO.mul(
            BNB_USD_PRICE.mul(parseEther('10')).div(parseEther('1'))
          ).div(parseEther('1'))
        );

      await priceFeed.setPrice(
        BNB_USD_PRICE.sub(parseEther('1')).div(
          ethers.BigNumber.from(10).pow(10)
        )
      );

      await priceOracle.setUSDFeed(WRAPPED_NATIVE_TOKEN, priceFeed.address);

      await expect(
        nativeTokenMarket
          .connect(alice)
          .withdraw(alice.address, parseEther('0.1'))
      ).to.rejectedWith('NativeTokenMarket__InsolventCaller()');
    });

    it('reverts on reentrancy', async () => {
      const { nativeTokenMarket, alice } = await loadFixture(deployFixture);

      const attacker: NativeTokenMarketDepositReentrancy = await deploy(
        'NativeTokenMarketWithdrawReentrancy',
        [nativeTokenMarket.address]
      );

      await nativeTokenMarket
        .connect(alice)
        .deposit(attacker.address, { value: parseEther('5') });

      await alice.sendTransaction({
        to: nativeTokenMarket.address,
        value: parseEther('1'),
      });

      await expect(
        nativeTokenMarket.connect(alice).withdraw(attacker.address, 1)
      ).to.rejectedWith('NativeTokenTransferFailed()');
    });
  });

  describe('function: receive()', function () {
    it('reverts on amount 0', async () => {
      const { nativeTokenMarket, alice } = await loadFixture(deployFixture);

      await expect(
        alice.sendTransaction({
          to: nativeTokenMarket.address,
          value: 0,
        })
      ).to.rejectedWith('NativeTokenMarket__InvalidAmount()');
    });

    it('accepts deposits', async () => {
      const { nativeTokenMarket, alice, owner } = await loadFixture(
        deployFixture
      );

      await expect(
        alice.sendTransaction({
          to: nativeTokenMarket.address,
          value: parseEther('10'),
        })
      )
        .to.emit(nativeTokenMarket, 'Deposit')
        .withArgs(alice.address, alice.address, parseEther('10'));

      const aliceAccount = await nativeTokenMarket.userAccount(alice.address);

      expect(aliceAccount.collateral).to.be.equal(parseEther('10'));
    });

    it('reverts on reentrancy', async () => {
      const { nativeTokenMarket, alice } = await loadFixture(deployFixture);

      const attacker = await deploy('NativeTokenMarketReceiveReentrancy', [
        nativeTokenMarket.address,
      ]);

      await alice.sendTransaction({
        to: nativeTokenMarket.address,
        value: parseEther('1'),
      });

      await expect(
        nativeTokenMarket.connect(alice).withdraw(attacker.address, 1)
      ).to.rejectedWith('NativeTokenTransferFailed()');
    });
  });

  describe('function: borrow(address,uint256)', function () {
    it('reverts if you try to borrow more than maxBorrowAmount', async () => {
      const { nativeTokenMarket, alice } = await loadFixture(deployFixture);

      await nativeTokenMarket.setMaxBorrowAmount(parseEther('100'));
      await nativeTokenMarket
        .connect(alice)
        .deposit(alice.address, { value: parseEther('1') });

      await expect(
        nativeTokenMarket
          .connect(alice)
          .borrow(alice.address, parseEther('101'))
      ).to.rejectedWith('NativeTokenMarket__MaxBorrowAmountReached()');
    });

    it('allows borrowing', async () => {
      const { nativeTokenMarket, alice, owner, dinero } = await loadFixture(
        deployFixture
      );

      await nativeTokenMarket
        .connect(alice)
        .deposit(alice.address, { value: parseEther('10') });

      const loan = await nativeTokenMarket.loan();
      const aliceAccount = await nativeTokenMarket.userAccount(alice.address);

      expect(loan.elastic).to.be.equal(0);
      expect(loan.base).to.be.equal(0);
      expect(aliceAccount.principal).to.be.equal(0);

      await expect(
        nativeTokenMarket
          .connect(alice)
          .borrow(owner.address, parseEther('1000'))
      )
        .to.emit(nativeTokenMarket, 'Borrow')
        .withArgs(
          alice.address,
          owner.address,
          parseEther('1000'),
          parseEther('1000')
        )
        .to.emit(dinero, 'Transfer')
        .withArgs(
          ethers.constants.AddressZero,
          owner.address,
          parseEther('1000')
        );

      const loan2 = await nativeTokenMarket.loan();
      const aliceAccount2 = await nativeTokenMarket.userAccount(alice.address);

      expect(loan2.elastic).to.be.equal(parseEther('1000'));
      expect(loan2.base).to.be.equal(parseEther('1000'));
      expect(aliceAccount2.principal).to.be.equal(parseEther('1000'));

      await time.increase(100);

      await expect(
        nativeTokenMarket.connect(alice).borrow(owner.address, parseEther('1'))
      ).to.emit(nativeTokenMarket, 'Accrue');

      await expect(
        nativeTokenMarket
          .connect(alice)
          .borrow(owner.address, parseEther('10000'))
      ).to.rejectedWith('NativeTokenMarket__InsolventCaller()');
    });

    it('reverts if the borrower is insolvent', async () => {
      const { nativeTokenMarket, alice, priceOracle } = await loadFixture(
        deployFixture
      );

      const priceFeed: PriceFeed = await deploy('PriceFeed');

      await nativeTokenMarket
        .connect(alice)
        .deposit(alice.address, { value: parseEther('10') });

      await priceFeed.setPrice(
        BNB_USD_PRICE.sub(parseEther('1')).div(
          ethers.BigNumber.from(10).pow(10)
        )
      );

      await priceOracle.setUSDFeed(WRAPPED_NATIVE_TOKEN, priceFeed.address);

      await expect(
        nativeTokenMarket
          .connect(alice)
          .borrow(
            alice.address,
            MAX_LTV_RATIO.mul(
              BNB_USD_PRICE.mul(parseEther('10')).div(parseEther('1'))
            ).div(parseEther('1'))
          )
      ).to.rejectedWith('NativeTokenMarket__InsolventCaller()');
    });

    it('reverts if price oracle returns 0', async () => {
      const { nativeTokenMarket, alice } = await loadFixture(deployFixture);

      await nativeTokenMarket
        .connect(alice)
        .deposit(alice.address, { value: parseEther('10') });

      const zeroPriceOracleFactory = await ethers.getContractFactory(
        'ZeroPriceOracle'
      );

      const zeroPriceOracle = await zeroPriceOracleFactory.deploy();

      await nativeTokenMarket.setOracle(zeroPriceOracle.address);

      await expect(
        nativeTokenMarket
          .connect(alice)
          .borrow(alice.address, parseEther('1000'))
      ).to.rejectedWith('NativeTokenMarket__InvalidExchangeRate()');
    });

    it('reverts on reentrancy', async () => {
      const { nativeTokenMarket, alice } = await loadFixture(deployFixture);

      const attacker = await deploy('NativeTokenMarketBorrowReentrancy', [
        nativeTokenMarket.address,
      ]);

      await alice.sendTransaction({
        to: nativeTokenMarket.address,
        value: parseEther('1'),
      });

      await nativeTokenMarket
        .connect(alice)
        .deposit(attacker.address, { value: parseEther('10') });

      await expect(
        nativeTokenMarket.connect(alice).withdraw(attacker.address, 1)
      ).to.rejectedWith('NativeTokenTransferFailed()');
    });
  });

  describe('function: repay', function () {
    it('repays loans', async () => {
      const { nativeTokenMarket, alice, owner, dinero } = await loadFixture(
        deployFixture
      );

      await nativeTokenMarket
        .connect(alice)
        .deposit(alice.address, { value: parseEther('10') });

      await nativeTokenMarket
        .connect(alice)
        .borrow(alice.address, parseEther('1000'));

      const loan = await nativeTokenMarket.loan();
      const aliceAccount = await nativeTokenMarket.userAccount(alice.address);

      expect(loan.base).to.be.equal(parseEther('1000'));
      expect(loan.elastic).to.be.equal(parseEther('1000'));
      expect(aliceAccount.principal).to.be.equal(parseEther('1000'));

      await expect(
        nativeTokenMarket.connect(owner).repay(alice.address, parseEther('500'))
      )
        .to.emit(nativeTokenMarket, 'Repay')
        .withArgs(owner.address, alice.address, parseEther('500'), anyUint)
        .to.emit(dinero, 'Transfer')
        .withArgs(owner.address, ethers.constants.AddressZero, anyUint)
        .to.emit(nativeTokenMarket, 'Accrue');

      const loan2 = await nativeTokenMarket.loan();
      const aliceAccount2 = await nativeTokenMarket.userAccount(alice.address);

      expect(loan2.base).to.be.equal(parseEther('1000').sub(parseEther('500')));

      expect(loan2.elastic).to.be.closeTo(
        loan.elastic.sub(parseEther('500')),
        parseEther('0.001')
      );

      expect(aliceAccount2.principal).to.be.equal(
        parseEther('1000').sub(parseEther('500'))
      );
    });
  });

  describe('function: setMaxLTVRatio', function () {
    it('reverts if it is not called by the owner', async () => {
      const { nativeTokenMarket, alice } = await loadFixture(deployFixture);

      await expect(
        nativeTokenMarket.connect(alice).setMaxLTVRatio(1)
      ).to.revertedWith('Ownable: caller is not the owner');
    });

    it('allows a maximum ltv of 90%', async () => {
      const { nativeTokenMarket } = await loadFixture(deployFixture);

      expect(await nativeTokenMarket.maxLTVRatio()).to.be.equal(
        parseEther('0.5')
      );

      await expect(nativeTokenMarket.setMaxLTVRatio(parseEther('0.9'))).to.emit(
        nativeTokenMarket,
        'MaxTVLRatio'
      );

      expect(await nativeTokenMarket.maxLTVRatio()).to.be.equal(
        parseEther('0.9')
      );

      await expect(
        nativeTokenMarket.setMaxLTVRatio(parseEther('0.91'))
      ).to.be.rejectedWith('NativeTokenMarket__InvalidMaxLTVRatio()');
    });
  });

  describe('function: setLiquidationFee', function () {
    it('reverts if it is not called by the owner', async () => {
      const { nativeTokenMarket, alice } = await loadFixture(deployFixture);

      await expect(
        nativeTokenMarket.connect(alice).setLiquidationFee(1)
      ).to.revertedWith('Ownable: caller is not the owner');
    });

    it('allows a maximum fee of 15%', async () => {
      const { nativeTokenMarket } = await loadFixture(deployFixture);

      expect(await nativeTokenMarket.liquidationFee()).to.be.equal(
        parseEther('0.1')
      );

      await expect(
        nativeTokenMarket.setLiquidationFee(parseEther('0.15'))
      ).to.emit(nativeTokenMarket, 'LiquidationFee');

      expect(await nativeTokenMarket.liquidationFee()).to.be.equal(
        parseEther('0.15')
      );

      await expect(
        nativeTokenMarket.setLiquidationFee(parseEther('0.151'))
      ).to.be.rejectedWith('NativeTokenMarket__InvalidLiquidationFee()');
    });
  });

  describe('function: setInterestRate', function () {
    it('reverts if it is not called by the owner', async () => {
      const { nativeTokenMarket, alice } = await loadFixture(deployFixture);

      await expect(
        nativeTokenMarket.connect(alice).setInterestRate(1)
      ).to.revertedWith('Ownable: caller is not the owner');
    });

    it('allows a maximum fee of 4%', async () => {
      const { nativeTokenMarket } = await loadFixture(deployFixture);

      expect((await nativeTokenMarket.loanTerms()).interestRate).to.be.equal(
        INTEREST_RATE
      );

      await expect(
        nativeTokenMarket.setInterestRate(
          ethers.BigNumber.from(13).mul(ethers.BigNumber.from(10).pow(8))
        )
      ).to.emit(nativeTokenMarket, 'InterestRate');

      expect((await nativeTokenMarket.loanTerms()).interestRate).to.be.equal(
        ethers.BigNumber.from(13).mul(ethers.BigNumber.from(10).pow(8))
      );

      await expect(
        nativeTokenMarket.setInterestRate(
          ethers.BigNumber.from(13).mul(ethers.BigNumber.from(10).pow(8)).add(1)
        )
      ).to.be.rejectedWith('NativeTokenMarket__InvalidInterestRate()');
    });
  });

  describe('function: setTreasury', function () {
    it('reverts if it is not called by the owner', async () => {
      const { nativeTokenMarket, alice } = await loadFixture(deployFixture);

      await expect(
        nativeTokenMarket
          .connect(alice)
          .setTreasury(ethers.constants.AddressZero)
      ).to.revertedWith('Ownable: caller is not the owner');
    });

    it('allows the treasury to be addressed', async () => {
      const { nativeTokenMarket, treasury } = await loadFixture(deployFixture);

      expect(await nativeTokenMarket.treasury()).to.be.equal(treasury.address);

      await expect(
        nativeTokenMarket.setTreasury(ethers.constants.AddressZero)
      ).to.emit(nativeTokenMarket, 'NewTreasury');

      expect(await nativeTokenMarket.treasury()).to.be.equal(
        ethers.constants.AddressZero
      );
    });
  });

  describe('function: setMaxBorrowAmount', function () {
    it('reverts if it is not called by the owner', async () => {
      const { nativeTokenMarket, alice } = await loadFixture(deployFixture);

      await expect(
        nativeTokenMarket.connect(alice).setMaxBorrowAmount(0)
      ).to.revertedWith('Ownable: caller is not the owner');
    });

    it('allows a maximum fee of 4%', async () => {
      const { nativeTokenMarket } = await loadFixture(deployFixture);

      expect(await nativeTokenMarket.maxBorrowAmount()).to.be.equal(
        parseEther('1000000')
      );

      await expect(nativeTokenMarket.setMaxBorrowAmount(0)).to.emit(
        nativeTokenMarket,
        'MaxBorrowAmount'
      );

      expect(await nativeTokenMarket.maxBorrowAmount()).to.be.equal(0);
    });
  });
});
