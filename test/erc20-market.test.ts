import { anyUint } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import {
  loadFixture,
  mine,
  time,
} from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { ethers, network } from 'hardhat';

import {
  Dinero,
  ERC20MarketV2,
  MintableERC20,
  PriceFeed,
  PriceOracle,
  Swap,
  TestERC20Market,
} from '../typechain-types';
import {
  BORROW_REQUEST,
  BTC_USD_PRICE,
  BTC_USD_PRICE_FEED,
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

const INTEREST_RATE = BigNumber.from(12e8);

const ONE_MONTH_IN_SECONDS = 2.628e6;

const LIQUIDATION_FEE = parseEther('0.1');

async function deployFixture() {
  const [owner, alice, bob, treasury, jose] = await ethers.getSigners();

  const [btc, dinero] = await Promise.all([
    deploy('MintableERC20', ['Bitcoin', 'BTC']) as Promise<MintableERC20>,
    deployUUPS('Dinero', []) as Promise<Dinero>,
  ]);

  const priceOracle: PriceOracle = await deployUUPS('PriceOracle', [
    WRAPPED_NATIVE_TOKEN,
  ]);

  const contractData = defaultAbiCoder.encode(
    ['address', 'address', 'address', 'address'],
    [dinero.address, btc.address, priceOracle.address, treasury.address]
  );

  const settingsData = defaultAbiCoder.encode(
    ['uint128', 'uint96', 'uint128', 'uint64'],
    [parseEther('0.5'), LIQUIDATION_FEE, parseEther('1000000'), INTEREST_RATE]
  );

  const erc20Market: TestERC20Market = await deployUUPS('TestERC20Market', [
    contractData,
    settingsData,
  ]);

  await Promise.all([
    btc.mint(alice.address, parseEther('10000')),
    btc
      .connect(alice)
      .approve(erc20Market.address, ethers.constants.MaxUint256),
    priceOracle.setUSDFeed(btc.address, BTC_USD_PRICE_FEED),
    dinero.grantRole(MINTER_ROLE, erc20Market.address),
    dinero.grantRole(MINTER_ROLE, owner.address),
  ]);

  await dinero.mint(owner.address, parseEther('1000000'));

  return {
    btc,
    dinero,
    alice,
    owner,
    bob,
    treasury,
    priceOracle,
    erc20Market,
    jose,
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

  describe('function: getDineroEarnings', function () {
    it('does not call accrue nor Dinero mint if there is no open loans', async () => {
      const { erc20Market, dinero } = await loadFixture(deployFixture);

      await expect(erc20Market.getDineroEarnings())
        .to.not.emit(erc20Market, 'Accrue')
        .to.not.emit(dinero, 'Transfer');
    });

    it('sends the earnings to the treasury', async () => {
      const { erc20Market, dinero, alice, treasury } = await loadFixture(
        deployFixture
      );

      await erc20Market.connect(alice).deposit(alice.address, parseEther('10'));
      await erc20Market
        .connect(alice)
        .borrow(alice.address, parseEther('100000'));

      await time.increase(ONE_MONTH_IN_SECONDS);

      await expect(erc20Market.getDineroEarnings())
        .to.emit(erc20Market, 'Accrue')
        .to.emit(dinero, 'Transfer')
        .withArgs(ethers.constants.AddressZero, treasury.address, anyUint)
        .to.emit(erc20Market, 'GetDineroEarnings')
        .withArgs(treasury.address, anyUint);

      const loanTerms = await erc20Market.loanTerms();
      const currentBlockNumber = await ethers.provider.getBlockNumber();

      expect(loanTerms.dnrEarned).to.be.equal(0);
      expect(loanTerms.lastAccrued.gte(currentBlockNumber)).to.be.equal(true);
    });
  });

  describe('collateral with non-standard decimals', function () {
    it('properly checks for solvency', async () => {
      const { priceOracle, treasury, dinero, alice } = await loadFixture(
        deployFixture
      );

      const smallBTC: MintableERC20 = await deploy('SmallMintableERC20', [
        'Bitcoin',
        'BTC',
      ]);

      await priceOracle.setUSDFeed(smallBTC.address, BTC_USD_PRICE_FEED);

      const contractData = defaultAbiCoder.encode(
        ['address', 'address', 'address', 'address'],
        [
          dinero.address,
          smallBTC.address,
          priceOracle.address,
          treasury.address,
        ]
      );

      const settingsData = defaultAbiCoder.encode(
        ['uint128', 'uint96', 'uint128', 'uint64'],
        [
          parseEther('0.5'),
          LIQUIDATION_FEE,
          parseEther('1000000'),
          INTEREST_RATE,
        ]
      );

      const erc20Market: TestERC20Market = await deployUUPS('TestERC20Market', [
        contractData,
        settingsData,
      ]);

      await Promise.all([
        smallBTC.mint(alice.address, ethers.BigNumber.from(10).pow(8).mul(5)),
        smallBTC
          .connect(alice)
          .approve(erc20Market.address, ethers.constants.MaxUint256),
        dinero.grantRole(MINTER_ROLE, erc20Market.address),
      ]);

      await erc20Market
        .connect(alice)
        .deposit(alice.address, ethers.BigNumber.from(10).pow(8).mul(2)); // deposit 2 BTC

      await expect(
        erc20Market.connect(alice).borrow(alice.address, BTC_USD_PRICE)
      ).not.rejected;
    });

    it('liquidates correctly', async () => {
      const { treasury, alice, owner, bob, jose, dinero, priceOracle } =
        await loadFixture(deployFixture);

      const smallBTC: MintableERC20 = await deploy('SmallMintableERC20', [
        'Bitcoin',
        'BTC',
      ]);

      await priceOracle.setUSDFeed(smallBTC.address, BTC_USD_PRICE_FEED);

      const contractData = defaultAbiCoder.encode(
        ['address', 'address', 'address', 'address'],
        [
          dinero.address,
          smallBTC.address,
          priceOracle.address,
          treasury.address,
        ]
      );

      const settingsData = defaultAbiCoder.encode(
        ['uint128', 'uint96', 'uint128', 'uint64'],
        [
          parseEther('0.5'),
          LIQUIDATION_FEE,
          parseEther('1000000'),
          INTEREST_RATE,
        ]
      );

      const erc20Market: TestERC20Market = await deployUUPS('TestERC20Market', [
        contractData,
        settingsData,
      ]);

      await Promise.all([
        smallBTC.mint(alice.address, ethers.BigNumber.from(10).pow(8).mul(10)),
        smallBTC
          .connect(alice)
          .approve(erc20Market.address, ethers.constants.MaxUint256),
        dinero.grantRole(MINTER_ROLE, erc20Market.address),
      ]);

      const priceFeed: PriceFeed = await deploy('PriceFeed');

      await priceFeed.setPrice(
        BTC_USD_PRICE.div(BigNumber.from(10).pow(10)).div(2)
      );

      await Promise.all([
        smallBTC.mint(bob.address, ethers.BigNumber.from(10).pow(8).mul(10)),
        smallBTC.mint(jose.address, ethers.BigNumber.from(10).pow(8).mul(10)),
        smallBTC
          .connect(bob)
          .approve(erc20Market.address, ethers.constants.MaxUint256),
        smallBTC
          .connect(jose)
          .approve(erc20Market.address, ethers.constants.MaxUint256),
      ]);

      await Promise.all([
        erc20Market
          .connect(alice)
          .request(
            [DEPOSIT_REQUEST, BORROW_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [alice.address, ethers.BigNumber.from(10).pow(8).mul(10)]
              ),
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [alice.address, parseEther('170000')]
              ),
            ]
          ),
        erc20Market
          .connect(bob)
          .request(
            [DEPOSIT_REQUEST, BORROW_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [bob.address, ethers.BigNumber.from(10).pow(8).mul(10)]
              ),
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [bob.address, parseEther('50000')]
              ),
            ]
          ),
        erc20Market
          .connect(jose)
          .request(
            [DEPOSIT_REQUEST, BORROW_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [jose.address, ethers.BigNumber.from(10).pow(8).mul(7)]
              ),
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [jose.address, parseEther('120000')]
              ),
            ]
          ),
      ]);

      const swap: Swap = await deploy('Swap', []);

      await time.increase(ONE_MONTH_IN_SECONDS);

      await priceOracle.setUSDFeed(smallBTC.address, priceFeed.address);

      await expect(
        erc20Market.liquidate(
          [alice.address, bob.address, jose.address],
          [
            ethers.constants.MaxUint256,
            ethers.constants.MaxUint256,
            parseEther('100000'),
          ],
          swap.address,
          ethers.constants.HashZero
        )
      )
        .to.emit(erc20Market, 'Liquidate')
        .withArgs(
          owner.address,
          alice.address,
          parseEther('170000'),
          anyUint,
          anyUint,
          anyUint
        )
        .to.emit(erc20Market, 'Liquidate')
        .withArgs(
          owner.address,
          jose.address,
          parseEther('100000'),
          anyUint,
          anyUint,
          anyUint
        )
        .to.emit(erc20Market, 'Accrue')
        .to.emit(dinero, 'Transfer')
        .withArgs(owner.address, ethers.constants.AddressZero, anyUint)
        .to.emit(smallBTC, 'Transfer')
        .withArgs(erc20Market.address, swap.address, anyUint)
        .to.emit(swap, 'SellOneToken');
    });
  });

  describe('function: getCollateralEarnings', function () {
    it('does not send any collateral if there are no earnings', async () => {
      const { erc20Market, btc } = await loadFixture(deployFixture);

      await expect(erc20Market.getCollateralEarnings())
        .to.not.emit(btc, 'Transfer')
        .to.not.emit(erc20Market, 'GetCollateralEarnings');

      expect((await erc20Market.loanTerms()).collateralEarned).to.be.equal(0);
    });

    it('sends the collateral earnings to the treasury', async () => {
      const { erc20Market, btc, alice, treasury } = await loadFixture(
        deployFixture
      );

      await Promise.all([
        btc.connect(alice).transfer(erc20Market.address, parseEther('2')),
        erc20Market.setCollateralEarnings(parseEther('1')),
      ]);

      expect((await erc20Market.loanTerms()).collateralEarned).to.be.equal(
        parseEther('1')
      );

      await expect(erc20Market.getCollateralEarnings())
        .to.emit(btc, 'Transfer')
        .withArgs(erc20Market.address, treasury.address, parseEther('1'))
        .to.emit(erc20Market, 'GetCollateralEarnings')
        .withArgs(treasury.address, parseEther('1'));

      expect((await erc20Market.loanTerms()).collateralEarned).to.be.equal(0);
    });
  });

  describe('function: accrue', function () {
    it('it does not accrue if there are no loans', async () => {
      const { erc20Market } = await loadFixture(deployFixture);

      const lastAccrued = (await erc20Market.loanTerms()).lastAccrued;
      const loan = await erc20Market.loan();

      await expect(erc20Market.accrue()).to.not.emit(erc20Market, 'Accrue');

      await time.increase(1000);

      await erc20Market.accrue();

      const loan2 = await erc20Market.loan();

      expect(
        (await erc20Market.loanTerms()).lastAccrued.gt(lastAccrued)
      ).to.be.equal(true);
      expect(loan.base).to.be.equal(loan2.base);
      expect(loan.elastic).to.be.equal(loan2.elastic);
    });

    it('it does not accrue if there is no interest rate', async () => {
      const { erc20Market, alice } = await loadFixture(deployFixture);

      const lastAccrued = (await erc20Market.loanTerms()).lastAccrued;
      const loan = await erc20Market.loan();
      await erc20Market.setInterestRate(0);
      await erc20Market.connect(alice).deposit(alice.address, parseEther('10'));

      await time.increase(1000);
      await expect(erc20Market.accrue()).to.not.emit(erc20Market, 'Accrue');

      const loan2 = await erc20Market.loan();

      expect(
        (await erc20Market.loanTerms()).lastAccrued.gt(lastAccrued)
      ).to.be.equal(true);
      expect(loan.base).to.be.equal(loan2.base);
      expect(loan.elastic).to.be.equal(loan2.elastic);
    });

    it('does not accrue if it is called within the same block', async () => {
      const { erc20Market, alice } = await loadFixture(deployFixture);

      await erc20Market.connect(alice).deposit(alice.address, parseEther('10'));
      await erc20Market
        .connect(alice)
        .borrow(alice.address, parseEther('100000'));

      await time.increase(ONE_MONTH_IN_SECONDS);

      await network.provider.send('evm_setAutomine', [false]);

      const firstAccrueTX = await erc20Market.accrue();

      const secondAccrueTX = await erc20Market.accrue();

      await mine(1);

      await network.provider.send('evm_setAutomine', [true]);

      await firstAccrueTX.wait(1);
      await secondAccrueTX.wait(1);

      // No event is emitted on first Stake
      // Only the second TX emitted an updatePool
      // Third Stake on the same block as the second one. So no event was emitted.
      expect(
        (
          await erc20Market.queryFilter(
            erc20Market.filters.Accrue(null),
            15_018_612
          )
        ).length
      ).to.be.equal(1);
    });

    it('properly updates the debt accumulated by the protocol', async () => {
      const { erc20Market, alice } = await loadFixture(deployFixture);

      await erc20Market.connect(alice).deposit(alice.address, parseEther('10'));

      await network.provider.send('evm_setAutomine', [false]);

      await erc20Market
        .connect(alice)
        .borrow(alice.address, parseEther('100000'));

      await mine(1);

      const loan = await erc20Market.loan();

      await time.increase(ONE_MONTH_IN_SECONDS);

      const accrueTX = await erc20Market.accrue();

      await mine(1);

      await accrueTX.wait(1);
      const loan2 = await erc20Market.loan();

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

  describe('function: deposit(address,uint256)', function () {
    it('reverts on amount or address 0', async () => {
      const { erc20Market, alice } = await loadFixture(deployFixture);

      await expect(
        erc20Market.connect(alice).deposit(ethers.constants.AddressZero, 1)
      ).to.rejectedWith('ERC20Market__InvalidAddress()');
      await expect(
        erc20Market.connect(alice).deposit(alice.address, 0)
      ).to.rejectedWith('ERC20Market__InvalidAmount()');
    });

    it('accepts deposits', async () => {
      const { erc20Market, alice, owner, btc } = await loadFixture(
        deployFixture
      );

      await expect(
        erc20Market.connect(alice).deposit(owner.address, parseEther('10'))
      )
        .to.emit(erc20Market, 'Deposit')
        .withArgs(alice.address, owner.address, parseEther('10'))
        .to.emit(btc, 'Transfer')
        .withArgs(alice.address, erc20Market.address, parseEther('10'));

      const aliceAccount = await erc20Market.accountOf(alice.address);
      const ownerAccount = await erc20Market.accountOf(owner.address);

      expect(aliceAccount.collateral).to.be.equal(0);
      expect(ownerAccount.collateral).to.be.equal(parseEther('10'));

      await erc20Market.borrow(owner.address, parseEther('100'));

      await time.increase(1000);

      await expect(
        erc20Market.connect(alice).deposit(owner.address, parseEther('10'))
      ).to.not.emit(erc20Market, 'Accrue');
    });
  });

  describe('function: withdraw(address, uint256)', function () {
    it('reverts on 0 amount withdraws', async () => {
      const { erc20Market, alice } = await loadFixture(deployFixture);

      await expect(erc20Market.withdraw(alice.address, 0)).to.rejectedWith(
        'ERC20Market__InvalidAmount()'
      );
    });

    it('allows solvent users to withdraw', async () => {
      const { erc20Market, alice, owner, btc } = await loadFixture(
        deployFixture
      );

      await erc20Market.connect(alice).deposit(alice.address, parseEther('10'));

      await erc20Market
        .connect(alice)
        .borrow(alice.address, parseEther('100000'));

      await time.increase(1000);

      await expect(
        erc20Market.connect(alice).withdraw(owner.address, parseEther('2'))
      )
        .to.emit(erc20Market, 'Accrue')
        .to.emit(erc20Market, 'Withdraw')
        .withArgs(alice.address, owner.address, parseEther('2'))
        .to.emit(btc, 'Transfer')
        .withArgs(erc20Market.address, owner.address, parseEther('2'));

      expect(
        (await erc20Market.accountOf(alice.address)).collateral
      ).to.be.equal(parseEther('8'));
    });

    it('does not allow insolvent users to withdraw', async () => {
      const { erc20Market, alice, btc, priceOracle } = await loadFixture(
        deployFixture
      );

      const priceFeed: PriceFeed = await deploy('PriceFeed');

      await erc20Market.connect(alice).deposit(alice.address, parseEther('10'));
      await erc20Market
        .connect(alice)
        .borrow(alice.address, parseEther('200000'));

      await priceFeed.setPrice(
        BTC_USD_PRICE.div(2).div(BigNumber.from(10).pow(10))
      );

      await priceOracle.setUSDFeed(btc.address, priceFeed.address);

      await expect(
        erc20Market.connect(alice).withdraw(alice.address, parseEther('0.1'))
      ).to.rejectedWith('ERC20Market__InsolventCaller()');
    });
  });

  describe('function: borrow(address,uint256)', function () {
    it('reverts if you try to borrow more than maxBorrowAmount', async () => {
      const { erc20Market, alice } = await loadFixture(deployFixture);

      await erc20Market.setMaxBorrowAmount(parseEther('100'));
      await erc20Market.connect(alice).deposit(alice.address, parseEther('1'));

      await expect(
        erc20Market.connect(alice).borrow(alice.address, parseEther('101'))
      ).to.rejectedWith('ERC20Market__MaxBorrowAmountReached()');
    });

    it('allows borrowing', async () => {
      const { erc20Market, alice, owner, dinero } = await loadFixture(
        deployFixture
      );

      await erc20Market.connect(alice).deposit(alice.address, parseEther('10'));

      const loan = await erc20Market.loan();
      const aliceAccount = await erc20Market.accountOf(alice.address);

      expect(loan.elastic).to.be.equal(0);
      expect(loan.base).to.be.equal(0);
      expect(aliceAccount.principal).to.be.equal(0);

      await expect(
        erc20Market.connect(alice).borrow(owner.address, parseEther('10000'))
      )
        .to.emit(erc20Market, 'Borrow')
        .withArgs(
          alice.address,
          owner.address,
          parseEther('10000'),
          parseEther('10000')
        )
        .to.emit(dinero, 'Transfer')
        .withArgs(
          ethers.constants.AddressZero,
          owner.address,
          parseEther('10000')
        );

      const loan2 = await erc20Market.loan();
      const aliceAccount2 = await erc20Market.accountOf(alice.address);

      expect(loan2.elastic).to.be.equal(parseEther('10000'));
      expect(loan2.base).to.be.equal(parseEther('10000'));
      expect(aliceAccount2.principal).to.be.equal(parseEther('10000'));

      await time.increase(100);

      await expect(
        erc20Market.connect(alice).borrow(owner.address, parseEther('1'))
      ).to.emit(erc20Market, 'Accrue');
    });

    it('reverts if the borrower is insolvent', async () => {
      const { erc20Market, alice, priceOracle, btc } = await loadFixture(
        deployFixture
      );

      const priceFeed: PriceFeed = await deploy('PriceFeed');

      await erc20Market.connect(alice).deposit(alice.address, parseEther('10'));

      await priceFeed.setPrice(
        BTC_USD_PRICE.div(2).div(BigNumber.from(10).pow(10))
      );

      await priceOracle.setUSDFeed(btc.address, priceFeed.address);

      await expect(
        erc20Market.connect(alice).borrow(alice.address, parseEther('105000'))
      ).to.rejectedWith('ERC20Market__InsolventCaller()');
    });

    it('reverts if price oracle returns 0', async () => {
      const { erc20Market, alice } = await loadFixture(deployFixture);

      await erc20Market.connect(alice).deposit(alice.address, parseEther('10'));

      const zeroPriceOracleFactory = await ethers.getContractFactory(
        'ZeroPriceOracle'
      );

      const zeroPriceOracle = await zeroPriceOracleFactory.deploy();

      await erc20Market.setOracle(zeroPriceOracle.address);

      await expect(
        erc20Market.connect(alice).borrow(alice.address, parseEther('1000'))
      ).to.rejectedWith('ERC20Market__InvalidExchangeRate()');
    });
  });

  describe('function: repay', function () {
    it('repays loans', async () => {
      const { erc20Market, alice, owner, dinero } = await loadFixture(
        deployFixture
      );

      await erc20Market.connect(alice).deposit(alice.address, parseEther('10'));

      await erc20Market
        .connect(alice)
        .borrow(alice.address, parseEther('100000'));

      const loan = await erc20Market.loan();
      const aliceAccount = await erc20Market.accountOf(alice.address);

      expect(loan.base).to.be.equal(parseEther('100000'));
      expect(loan.elastic).to.be.equal(parseEther('100000'));
      expect(aliceAccount.principal).to.be.equal(parseEther('100000'));

      await expect(
        erc20Market.connect(owner).repay(alice.address, parseEther('5000'))
      )
        .to.emit(erc20Market, 'Repay')
        .withArgs(owner.address, alice.address, parseEther('5000'), anyUint)
        .to.emit(dinero, 'Transfer')
        .withArgs(owner.address, ethers.constants.AddressZero, anyUint)
        .to.emit(erc20Market, 'Accrue');

      const loan2 = await erc20Market.loan();
      const aliceAccount2 = await erc20Market.accountOf(alice.address);

      expect(loan2.base).to.be.equal(
        parseEther('100000').sub(parseEther('5000'))
      );

      expect(loan2.elastic).to.be.closeTo(
        loan.elastic.sub(parseEther('5000')),
        parseEther('0.001')
      );

      expect(aliceAccount2.principal).to.be.equal(
        parseEther('100000').sub(parseEther('5000'))
      );
    });
  });

  describe('function: setMaxLTVRatio', function () {
    it('reverts if it is not called by the owner', async () => {
      const { erc20Market, alice } = await loadFixture(deployFixture);

      await expect(
        erc20Market.connect(alice).setMaxLTVRatio(1)
      ).to.revertedWith('Ownable: caller is not the owner');
    });

    it('allows a maximum ltv of 90%', async () => {
      const { erc20Market } = await loadFixture(deployFixture);

      expect(await erc20Market.maxLTVRatio()).to.be.equal(parseEther('0.5'));

      await expect(erc20Market.setMaxLTVRatio(parseEther('0.9'))).to.emit(
        erc20Market,
        'MaxTVLRatio'
      );

      expect(await erc20Market.maxLTVRatio()).to.be.equal(parseEther('0.9'));

      await expect(
        erc20Market.setMaxLTVRatio(parseEther('0.91'))
      ).to.be.rejectedWith('ERC20Market__InvalidMaxLTVRatio()');
    });
  });

  describe('function: setLiquidationFee', function () {
    it('reverts if it is not called by the owner', async () => {
      const { erc20Market, alice } = await loadFixture(deployFixture);

      await expect(
        erc20Market.connect(alice).setLiquidationFee(1)
      ).to.revertedWith('Ownable: caller is not the owner');
    });

    it('allows a maximum fee of 15%', async () => {
      const { erc20Market } = await loadFixture(deployFixture);

      expect(await erc20Market.liquidationFee()).to.be.equal(parseEther('0.1'));

      await expect(erc20Market.setLiquidationFee(parseEther('0.15'))).to.emit(
        erc20Market,
        'LiquidationFee'
      );

      expect(await erc20Market.liquidationFee()).to.be.equal(
        parseEther('0.15')
      );

      await expect(
        erc20Market.setLiquidationFee(parseEther('0.151'))
      ).to.be.rejectedWith('ERC20Market__InvalidLiquidationFee()');
    });
  });

  describe('function: setInterestRate', function () {
    it('reverts if it is not called by the owner', async () => {
      const { erc20Market, alice } = await loadFixture(deployFixture);

      await expect(
        erc20Market.connect(alice).setInterestRate(1)
      ).to.revertedWith('Ownable: caller is not the owner');
    });

    it('allows a maximum fee of 4%', async () => {
      const { erc20Market } = await loadFixture(deployFixture);

      expect((await erc20Market.loanTerms()).interestRate).to.be.equal(
        INTEREST_RATE
      );

      await expect(
        erc20Market.setInterestRate(
          BigNumber.from(13).mul(BigNumber.from(10).pow(8))
        )
      ).to.emit(erc20Market, 'InterestRate');

      expect((await erc20Market.loanTerms()).interestRate).to.be.equal(
        BigNumber.from(13).mul(BigNumber.from(10).pow(8))
      );

      await expect(
        erc20Market.setInterestRate(
          BigNumber.from(13).mul(BigNumber.from(10).pow(8)).add(1)
        )
      ).to.be.rejectedWith('ERC20Market__InvalidInterestRate()');
    });
  });

  describe('function: setTreasury', function () {
    it('reverts if it is not called by the owner', async () => {
      const { erc20Market, alice } = await loadFixture(deployFixture);

      await expect(
        erc20Market.connect(alice).setTreasury(ethers.constants.AddressZero)
      ).to.revertedWith('Ownable: caller is not the owner');
    });

    it('allows the treasury to be addressed', async () => {
      const { erc20Market, treasury } = await loadFixture(deployFixture);

      expect(await erc20Market.treasury()).to.be.equal(treasury.address);

      await expect(
        erc20Market.setTreasury(ethers.constants.AddressZero)
      ).to.emit(erc20Market, 'NewTreasury');

      expect(await erc20Market.treasury()).to.be.equal(
        ethers.constants.AddressZero
      );
    });
  });

  describe('function: setMaxBorrowAmount', function () {
    it('reverts if it is not called by the owner', async () => {
      const { erc20Market, alice } = await loadFixture(deployFixture);

      await expect(
        erc20Market.connect(alice).setMaxBorrowAmount(0)
      ).to.revertedWith('Ownable: caller is not the owner');
    });

    it('updates the max borrow amount', async () => {
      const { erc20Market } = await loadFixture(deployFixture);

      expect(await erc20Market.maxBorrowAmount()).to.be.equal(
        parseEther('1000000')
      );

      await expect(erc20Market.setMaxBorrowAmount(0)).to.emit(
        erc20Market,
        'MaxBorrowAmount'
      );

      expect(await erc20Market.maxBorrowAmount()).to.be.equal(0);
    });
  });

  describe('function: request deposit', function () {
    it('reverts on amount or address 0', async () => {
      const { erc20Market, alice } = await loadFixture(deployFixture);

      await expect(
        erc20Market
          .connect(alice)
          .request(
            [DEPOSIT_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [ethers.constants.AddressZero, parseEther('10')]
              ),
            ]
          )
      ).to.rejectedWith('ERC20Market__InvalidAddress()');
      await expect(
        erc20Market
          .connect(alice)
          .request(
            [DEPOSIT_REQUEST],
            [defaultAbiCoder.encode(['address', 'uint256'], [alice.address, 0])]
          )
      ).to.rejectedWith('ERC20Market__InvalidAmount()');
    });

    it('accepts deposits', async () => {
      const { erc20Market, alice, owner, btc } = await loadFixture(
        deployFixture
      );

      await expect(
        erc20Market
          .connect(alice)
          .request(
            [DEPOSIT_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [owner.address, parseEther('10')]
              ),
            ]
          )
      )
        .to.emit(erc20Market, 'Deposit')
        .withArgs(alice.address, owner.address, parseEther('10'))
        .to.emit(btc, 'Transfer')
        .withArgs(alice.address, erc20Market.address, parseEther('10'));

      const aliceAccount = await erc20Market.accountOf(alice.address);
      const ownerAccount = await erc20Market.accountOf(owner.address);

      expect(aliceAccount.collateral).to.be.equal(0);
      expect(ownerAccount.collateral).to.be.equal(parseEther('10'));

      await erc20Market.borrow(owner.address, parseEther('100'));

      await time.increase(1000);

      await expect(
        erc20Market.connect(alice).deposit(owner.address, parseEther('10'))
      ).to.not.emit(erc20Market, 'Accrue');
    });
  });

  describe('function: request withdraw', function () {
    it('reverts on 0 amount withdraws', async () => {
      const { erc20Market, alice } = await loadFixture(deployFixture);

      await expect(
        erc20Market.request(
          [WITHDRAW_REQUEST],
          [defaultAbiCoder.encode(['address', 'uint256'], [alice.address, 0])]
        )
      ).to.rejectedWith('ERC20Market__InvalidAmount()');
    });

    it('allows solvent users to withdraw', async () => {
      const { erc20Market, alice, owner, btc } = await loadFixture(
        deployFixture
      );

      await erc20Market
        .connect(alice)
        .request(
          [DEPOSIT_REQUEST, BORROW_REQUEST],
          [
            defaultAbiCoder.encode(
              ['address', 'uint256'],
              [alice.address, parseEther('10')]
            ),
            defaultAbiCoder.encode(
              ['address', 'uint256'],
              [alice.address, parseEther('10')]
            ),
          ]
        );

      await time.increase(1000);

      await expect(
        erc20Market
          .connect(alice)
          .request(
            [WITHDRAW_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [owner.address, parseEther('2')]
              ),
            ]
          )
      )
        .to.emit(erc20Market, 'Accrue')
        .to.emit(erc20Market, 'Withdraw')
        .withArgs(alice.address, owner.address, parseEther('2'))
        .to.emit(btc, 'Transfer')
        .withArgs(erc20Market.address, owner.address, parseEther('2'));

      expect(
        (await erc20Market.accountOf(alice.address)).collateral
      ).to.be.equal(parseEther('8'));
    });

    it('does not allow insolvent users to withdraw', async () => {
      const { erc20Market, alice, btc, priceOracle } = await loadFixture(
        deployFixture
      );

      const priceFeed: PriceFeed = await deploy('PriceFeed');

      await erc20Market
        .connect(alice)
        .request(
          [DEPOSIT_REQUEST, BORROW_REQUEST],
          [
            defaultAbiCoder.encode(
              ['address', 'uint256'],
              [alice.address, parseEther('10')]
            ),
            defaultAbiCoder.encode(
              ['address', 'uint256'],
              [alice.address, parseEther('200000')]
            ),
          ]
        );

      await priceFeed.setPrice(
        BTC_USD_PRICE.div(2).div(BigNumber.from(10).pow(10))
      );

      await priceOracle.setUSDFeed(btc.address, priceFeed.address);

      await expect(
        erc20Market
          .connect(alice)
          .request(
            [WITHDRAW_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [alice.address, parseEther('0.1')]
              ),
            ]
          )
      ).to.rejectedWith('ERC20Market__InsolventCaller()');
    });
  });

  describe('function: request borrow', function () {
    it('reverts if you try to borrow more than maxBorrowAmount', async () => {
      const { erc20Market, alice } = await loadFixture(deployFixture);

      await erc20Market.setMaxBorrowAmount(parseEther('100'));

      await expect(
        erc20Market
          .connect(alice)
          .request(
            [DEPOSIT_REQUEST, BORROW_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [alice.address, parseEther('1')]
              ),
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [alice.address, parseEther('101')]
              ),
            ]
          )
      ).to.rejectedWith('ERC20Market__MaxBorrowAmountReached()');
    });

    it('allows borrowing', async () => {
      const { erc20Market, alice, owner, dinero } = await loadFixture(
        deployFixture
      );

      await erc20Market.connect(alice).deposit(alice.address, parseEther('10'));

      const loan = await erc20Market.loan();
      const aliceAccount = await erc20Market.accountOf(alice.address);

      expect(loan.elastic).to.be.equal(0);
      expect(loan.base).to.be.equal(0);
      expect(aliceAccount.principal).to.be.equal(0);

      await expect(
        erc20Market
          .connect(alice)
          .request(
            [BORROW_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [owner.address, parseEther('10000')]
              ),
            ]
          )
      )
        .to.emit(erc20Market, 'Borrow')
        .withArgs(
          alice.address,
          owner.address,
          parseEther('10000'),
          parseEther('10000')
        )
        .to.emit(dinero, 'Transfer')
        .withArgs(
          ethers.constants.AddressZero,
          owner.address,
          parseEther('10000')
        );

      const loan2 = await erc20Market.loan();
      const aliceAccount2 = await erc20Market.accountOf(alice.address);

      expect(loan2.elastic).to.be.equal(parseEther('10000'));
      expect(loan2.base).to.be.equal(parseEther('10000'));
      expect(aliceAccount2.principal).to.be.equal(parseEther('10000'));

      await time.increase(100);

      await expect(
        erc20Market
          .connect(alice)
          .request(
            [BORROW_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [owner.address, parseEther('1')]
              ),
            ]
          )
      ).to.emit(erc20Market, 'Accrue');
    });

    it('reverts if the borrower is insolvent', async () => {
      const { erc20Market, alice, priceOracle, btc } = await loadFixture(
        deployFixture
      );

      const priceFeed: PriceFeed = await deploy('PriceFeed');

      await erc20Market.connect(alice).deposit(alice.address, parseEther('10'));

      await priceFeed.setPrice(
        BTC_USD_PRICE.div(2).div(BigNumber.from(10).pow(10))
      );

      await priceOracle.setUSDFeed(btc.address, priceFeed.address);

      await expect(
        erc20Market
          .connect(alice)
          .request(
            [BORROW_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [alice.address, parseEther('105000')]
              ),
            ]
          )
      ).to.rejectedWith('ERC20Market__InsolventCaller()');
    });

    it('reverts if price oracle returns 0', async () => {
      const { erc20Market, alice } = await loadFixture(deployFixture);

      await erc20Market.connect(alice).deposit(alice.address, parseEther('10'));

      const zeroPriceOracleFactory = await ethers.getContractFactory(
        'ZeroPriceOracle'
      );

      const zeroPriceOracle = await zeroPriceOracleFactory.deploy();

      await erc20Market.setOracle(zeroPriceOracle.address);

      await expect(
        erc20Market
          .connect(alice)
          .request(
            [BORROW_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [alice.address, parseEther('1000')]
              ),
            ]
          )
      ).to.rejectedWith('ERC20Market__InvalidExchangeRate()');
    });
  });

  it('request reverts if an invalid action is passed', async () => {
    const { erc20Market, alice } = await loadFixture(deployFixture);
    await expect(
      erc20Market.request(
        [100],
        [
          defaultAbiCoder.encode(
            ['address', 'uint256'],
            [alice.address, parseEther('1000')]
          ),
        ]
      )
    ).to.rejectedWith('ERC20Market__InvalidRequest()');
  });

  describe('function: request repay', function () {
    it('repays loans', async () => {
      const { erc20Market, alice, owner, dinero } = await loadFixture(
        deployFixture
      );

      await erc20Market
        .connect(alice)
        .request(
          [DEPOSIT_REQUEST, BORROW_REQUEST],
          [
            defaultAbiCoder.encode(
              ['address', 'uint256'],
              [alice.address, parseEther('10')]
            ),
            defaultAbiCoder.encode(
              ['address', 'uint256'],
              [alice.address, parseEther('100000')]
            ),
          ]
        );

      const loan = await erc20Market.loan();
      const aliceAccount = await erc20Market.accountOf(alice.address);

      expect(loan.base).to.be.equal(parseEther('100000'));
      expect(loan.elastic).to.be.equal(parseEther('100000'));
      expect(aliceAccount.principal).to.be.equal(parseEther('100000'));

      await expect(
        erc20Market.request(
          [REPAY_REQUEST],
          [
            defaultAbiCoder.encode(
              ['address', 'uint256'],
              [alice.address, parseEther('5000')]
            ),
          ]
        )
      )
        .to.emit(erc20Market, 'Repay')
        .withArgs(owner.address, alice.address, parseEther('5000'), anyUint)
        .to.emit(dinero, 'Transfer')
        .withArgs(owner.address, ethers.constants.AddressZero, anyUint)
        .to.emit(erc20Market, 'Accrue');

      const loan2 = await erc20Market.loan();
      const aliceAccount2 = await erc20Market.accountOf(alice.address);

      expect(loan2.base).to.be.equal(
        parseEther('100000').sub(parseEther('5000'))
      );

      expect(loan2.elastic).to.be.closeTo(
        loan.elastic.sub(parseEther('5000')),
        parseEther('0.001')
      );

      expect(aliceAccount2.principal).to.be.equal(
        parseEther('100000').sub(parseEther('5000'))
      );
    });
  });

  describe('function: liquidate', function () {
    it('reverts if there are no underwater positions', async () => {
      const { erc20Market, alice, owner } = await loadFixture(deployFixture);

      await erc20Market
        .connect(alice)
        .request(
          [DEPOSIT_REQUEST, BORROW_REQUEST],
          [
            defaultAbiCoder.encode(
              ['address', 'uint256'],
              [alice.address, parseEther('10')]
            ),
            defaultAbiCoder.encode(
              ['address', 'uint256'],
              [alice.address, parseEther('100000')]
            ),
          ]
        );

      await expect(
        erc20Market.liquidate(
          [alice.address],
          [parseEther('1000')],
          owner.address,
          []
        )
      ).to.rejectedWith('ERC20Market__InvalidLiquidationAmount()');
    });

    it('liquidates without calling {sellOneToken}', async () => {
      const { erc20Market, btc, alice, owner, bob, jose, dinero, priceOracle } =
        await loadFixture(deployFixture);

      const priceFeed: PriceFeed = await deploy('PriceFeed');
      await priceFeed.setPrice(
        BTC_USD_PRICE.div(BigNumber.from(10).pow(10)).div(2)
      );

      await Promise.all([
        btc.mint(bob.address, parseEther('10')),
        btc.mint(jose.address, parseEther('10')),
        btc
          .connect(bob)
          .approve(erc20Market.address, ethers.constants.MaxUint256),
        btc
          .connect(jose)
          .approve(erc20Market.address, ethers.constants.MaxUint256),
      ]);

      await Promise.all([
        erc20Market
          .connect(alice)
          .request(
            [DEPOSIT_REQUEST, BORROW_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [alice.address, parseEther('10')]
              ),
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [alice.address, parseEther('170000')]
              ),
            ]
          ),
        erc20Market
          .connect(bob)
          .request(
            [DEPOSIT_REQUEST, BORROW_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [bob.address, parseEther('10')]
              ),
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [bob.address, parseEther('50000')]
              ),
            ]
          ),
        erc20Market
          .connect(jose)
          .request(
            [DEPOSIT_REQUEST, BORROW_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [jose.address, parseEther('7')]
              ),
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [jose.address, parseEther('120000')]
              ),
            ]
          ),
      ]);

      const [
        marketCollateralBalance,
        aliceAccount,
        bobAccount,
        joseAccount,
        loan,
        ownerDNRBalance,
        ownerBTCBalance,
      ] = await Promise.all([
        btc.balanceOf(erc20Market.address),
        erc20Market.accountOf(alice.address),
        erc20Market.accountOf(bob.address),
        erc20Market.accountOf(jose.address),
        erc20Market.loan(),
        dinero.balanceOf(owner.address),
        btc.balanceOf(owner.address),
      ]);

      expect(marketCollateralBalance).to.be.equal(parseEther('27'));

      expect(aliceAccount.collateral).to.be.equal(parseEther('10'));
      expect(aliceAccount.principal).to.be.equal(parseEther('170000'));

      expect(bobAccount.collateral).to.be.equal(parseEther('10'));

      // Fees get accrued every  second. So the principal will be a bit lower than the elastic
      expect(bobAccount.principal).to.be.closeTo(
        parseEther('50000'),
        parseEther('1')
      );

      expect(joseAccount.collateral).to.be.equal(parseEther('7'));
      expect(joseAccount.principal).to.be.closeTo(
        parseEther('120000'),
        parseEther('1')
      );

      expect(
        loan.elastic.gt(
          parseEther('170000')
            .add(parseEther('50000'))
            .add(parseEther('120000'))
        )
      ).to.be.equal(true);

      expect(loan.base).to.be.equal(
        aliceAccount.principal
          .add(joseAccount.principal)
          .add(bobAccount.principal)
      );

      await time.increase(ONE_MONTH_IN_SECONDS);

      await priceOracle.setUSDFeed(btc.address, priceFeed.address);

      const loanElastic = (await erc20Market.loan()).elastic;

      await expect(
        erc20Market.liquidate(
          [alice.address, bob.address, jose.address],
          [
            ethers.constants.MaxUint256,
            ethers.constants.MaxUint256,
            parseEther('100000'),
          ],
          owner.address,
          []
        )
      )
        .to.emit(erc20Market, 'Liquidate')
        .withArgs(
          owner.address,
          alice.address,
          parseEther('170000'),
          anyUint,
          anyUint,
          anyUint
        )
        .to.emit(erc20Market, 'Liquidate')
        .withArgs(
          owner.address,
          jose.address,
          parseEther('100000'),
          anyUint,
          anyUint,
          anyUint
        )
        .to.emit(erc20Market, 'Accrue')
        .to.emit(dinero, 'Transfer')
        .withArgs(owner.address, ethers.constants.AddressZero, anyUint)
        .to.emit(btc, 'Transfer')
        .withArgs(erc20Market.address, owner.address, anyUint);

      const [
        marketCollateralBalance2,
        aliceAccount2,
        bobAccount2,
        joseAccount2,
        loan2,
        ownerDNRBalance2,
        loanTerms2,
        ownerBTCBalanc2,
      ] = await Promise.all([
        btc.balanceOf(erc20Market.address),
        erc20Market.accountOf(alice.address),
        erc20Market.accountOf(bob.address),
        erc20Market.accountOf(jose.address),
        erc20Market.loan(),
        dinero.balanceOf(owner.address),
        erc20Market.loanTerms(),
        btc.balanceOf(owner.address),
      ]);

      const collateralLiquidate = joseAccount.collateral
        .sub(joseAccount2.collateral)
        .add(aliceAccount.collateral.sub(aliceAccount2.collateral));

      const alicePrincipalRepaid = aliceAccount.principal.sub(
        aliceAccount2.principal
      );

      const josePrincipalRepaid = joseAccount.principal.sub(
        joseAccount2.principal
      );

      const principalRepaid = josePrincipalRepaid.add(alicePrincipalRepaid);

      expect(aliceAccount2.principal).to.be.equal(0);
      expect(bobAccount2.principal).to.be.equal(bobAccount.principal);
      expect(joseAccount2.principal).to.be.closeTo(
        parseEther('20000'),
        parseEther('1')
      );

      expect(aliceAccount2.collateral).to.be.closeTo(
        aliceAccount.collateral.sub(
          collateralLiquidate.mul(alicePrincipalRepaid).div(principalRepaid)
        ),
        1
      );

      expect(bobAccount2.collateral).to.be.equal(bobAccount.collateral);

      expect(joseAccount2.collateral).to.be.closeTo(
        joseAccount.collateral.sub(
          collateralLiquidate.mul(josePrincipalRepaid).div(principalRepaid)
        ),
        1
      );

      expect(loan2.base).to.be.equal(loan.base.sub(principalRepaid));

      expect(marketCollateralBalance2).to.be.equal(
        bobAccount2.collateral
          .add(joseAccount2.collateral)
          .add(aliceAccount2.collateral)
          .add(loanTerms2.collateralEarned)
      );

      // Liquidator got compensated for liquidating
      expect(ownerBTCBalanc2).to.be.equal(
        ownerBTCBalance
          .add(collateralLiquidate)
          .sub(loanTerms2.collateralEarned)
      );

      // Liquidator covered the loan
      expect(ownerDNRBalance2).to.be.closeTo(
        ownerDNRBalance.sub(
          loanElastic.sub(loan2.elastic).add(loanTerms2.dnrEarned)
        ),
        parseEther('0.01')
      );
    });

    it('calls {sellOneToken} on recipient', async () => {
      const { erc20Market, btc, alice, owner, bob, jose, dinero, priceOracle } =
        await loadFixture(deployFixture);

      const priceFeed: PriceFeed = await deploy('PriceFeed');
      await priceFeed.setPrice(
        BTC_USD_PRICE.div(BigNumber.from(10).pow(10)).div(2)
      );

      await Promise.all([
        btc.mint(bob.address, parseEther('10')),
        btc.mint(jose.address, parseEther('10')),
        btc
          .connect(bob)
          .approve(erc20Market.address, ethers.constants.MaxUint256),
        btc
          .connect(jose)
          .approve(erc20Market.address, ethers.constants.MaxUint256),
      ]);

      await Promise.all([
        erc20Market
          .connect(alice)
          .request(
            [DEPOSIT_REQUEST, BORROW_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [alice.address, parseEther('10')]
              ),
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [alice.address, parseEther('170000')]
              ),
            ]
          ),
        erc20Market
          .connect(bob)
          .request(
            [DEPOSIT_REQUEST, BORROW_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [bob.address, parseEther('10')]
              ),
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [bob.address, parseEther('50000')]
              ),
            ]
          ),
        erc20Market
          .connect(jose)
          .request(
            [DEPOSIT_REQUEST, BORROW_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [jose.address, parseEther('7')]
              ),
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [jose.address, parseEther('120000')]
              ),
            ]
          ),
      ]);

      const swap: Swap = await deploy('Swap', []);

      await time.increase(ONE_MONTH_IN_SECONDS);

      await priceOracle.setUSDFeed(btc.address, priceFeed.address);

      await expect(
        erc20Market.liquidate(
          [alice.address, bob.address, jose.address],
          [
            ethers.constants.MaxUint256,
            ethers.constants.MaxUint256,
            parseEther('100000'),
          ],
          swap.address,
          ethers.constants.HashZero
        )
      )
        .to.emit(erc20Market, 'Liquidate')
        .withArgs(
          owner.address,
          alice.address,
          parseEther('170000'),
          anyUint,
          anyUint,
          anyUint
        )
        .to.emit(erc20Market, 'Liquidate')
        .withArgs(
          owner.address,
          jose.address,
          parseEther('100000'),
          anyUint,
          anyUint,
          anyUint
        )
        .to.emit(erc20Market, 'Accrue')
        .to.emit(dinero, 'Transfer')
        .withArgs(owner.address, ethers.constants.AddressZero, anyUint)
        .to.emit(btc, 'Transfer')
        .withArgs(erc20Market.address, swap.address, anyUint)
        .to.emit(swap, 'SellOneToken');
    });
  });

  describe('Upgrade functionality', function () {
    it('reverts if it is not upgraded by the owner', async () => {
      const { erc20Market } = await loadFixture(deployFixture);

      await erc20Market.renounceOwnership();

      await expect(upgrade(erc20Market, 'ERC20MarketV2')).to.be.revertedWith(
        'Ownable: caller is not the owner'
      );
    });

    it('upgrades to version 2', async () => {
      const { erc20Market, alice } = await loadFixture(deployFixture);

      await erc20Market.connect(alice).deposit(alice.address, parseEther('10'));

      expect(
        (await erc20Market.accountOf(alice.address)).collateral
      ).to.be.equal(parseEther('10'));

      const erc20MarketV2: ERC20MarketV2 = await upgrade(
        erc20Market,
        'ERC20MarketV2'
      );

      const [version, aliceAccount] = await Promise.all([
        erc20MarketV2.version(),
        erc20MarketV2.accountOf(alice.address),
      ]);

      expect(version).to.be.equal('v2');
      expect(aliceAccount.collateral).to.be.equal(parseEther('10'));
    });
  });
});
