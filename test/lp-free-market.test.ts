import { anyUint } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import {
  loadFixture,
  mine,
  time,
} from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';

import {
  CasaDePapel,
  Dinero,
  Factory,
  InterestToken,
  LPFreeMarketV2,
  MintableERC20,
  PriceOracle,
  Router,
  Swap,
  TestLPFreeMarket,
  WNT,
} from '../typechain-types';
import {
  BNB_USD_PRICE,
  BNB_USD_PRICE_FEED,
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

const START_BLOCK = 10;

const INTEREST_PER_BLOCK = parseEther('15');

const MAX_LTV_RATIO = parseEther('0.5');

const MAX_BORROW_AMOUNT = parseEther('1000000');

// 4.9 tokens
const ALICE_LP_BALANCE = ethers.BigNumber.from('4993667587603623478');

// 8_336
const LP_TOKEN_USD_PRICE = ethers.BigNumber.from('8336415924524375883624');

async function deployFixture() {
  const [owner, alice, bob, treasury, jose, james, milo] =
    await ethers.getSigners();

  const [btc, wnt, factory, dinero, ipx] = await Promise.all([
    deploy('MintableERC20', ['Bitcoin', 'BTC']) as Promise<MintableERC20>,
    deploy('WNT', []) as Promise<WNT>,
    deploy('Factory', []) as Promise<Factory>,
    deployUUPS('Dinero', []) as Promise<Dinero>,
    deployUUPS('InterestToken', []) as Promise<InterestToken>,
  ]);

  await factory.createPair(btc.address, wnt.address, false);

  const pairAddress = await factory.getPair(btc.address, wnt.address, false);

  const volatilePair = (await ethers.getContractFactory('Pair')).attach(
    pairAddress
  );

  const router: Router = await deploy('Router', [factory.address, wnt.address]);

  const priceOracle: PriceOracle = await deployUUPS('PriceOracle', [
    WRAPPED_NATIVE_TOKEN,
  ]);

  const casaDePapel: CasaDePapel = await deploy('CasaDePapel', [
    ipx.address,
    treasury.address,
    INTEREST_PER_BLOCK,
    START_BLOCK,
  ]);

  const contractData = defaultAbiCoder.encode(
    [
      'address',
      'address',
      'address',
      'address',
      'address',
      'address',
      'address',
    ],
    [
      router.address,
      dinero.address,
      volatilePair.address,
      ipx.address,
      priceOracle.address,
      casaDePapel.address,
      treasury.address,
    ]
  );

  const settingsData = defaultAbiCoder.encode(
    ['uint128', 'uint96', 'uint128', 'uint96'],
    [MAX_LTV_RATIO, LIQUIDATION_FEE, MAX_BORROW_AMOUNT, 1]
  );

  const lpFreeMarket: TestLPFreeMarket = await deployUUPS('TestLPFreeMarket', [
    contractData,
    settingsData,
  ]);

  await Promise.all([
    ipx.grantRole(MINTER_ROLE, casaDePapel.address),
    btc.mint(james.address, parseEther('10000')),
    btc.connect(james).approve(router.address, ethers.constants.MaxUint256),
    btc.mint(bob.address, parseEther('10000')),
    btc.connect(bob).approve(router.address, ethers.constants.MaxUint256),
    btc.mint(milo.address, parseEther('10000')),
    btc.connect(milo).approve(router.address, ethers.constants.MaxUint256),
    priceOracle.setUSDFeed(btc.address, BTC_USD_PRICE_FEED),
    priceOracle.setUSDFeed(wnt.address, BNB_USD_PRICE_FEED),
    dinero.grantRole(MINTER_ROLE, lpFreeMarket.address),
    dinero.grantRole(MINTER_ROLE, owner.address),
    volatilePair
      .connect(alice)
      .approve(lpFreeMarket.address, ethers.constants.MaxUint256),
    volatilePair
      .connect(bob)
      .approve(lpFreeMarket.address, ethers.constants.MaxUint256),
    volatilePair
      .connect(milo)
      .approve(lpFreeMarket.address, ethers.constants.MaxUint256),
  ]);

  await dinero.mint(owner.address, parseEther('1000000'));

  await casaDePapel.addPool(1000, volatilePair.address, false);

  const nativeTokenAmount = BTC_USD_PRICE.mul(parseEther('1')).div(
    BNB_USD_PRICE
  );

  await router
    .connect(james)
    .addLiquidityNativeToken(
      btc.address,
      false,
      parseEther('0.5'),
      0,
      0,
      alice.address,
      ethers.constants.MaxUint256,
      { value: nativeTokenAmount.mul(parseEther('0.5')).div(parseEther('1')) }
    );

  await router
    .connect(bob)
    .addLiquidityNativeToken(
      btc.address,
      false,
      parseEther('0.5'),
      0,
      0,
      bob.address,
      ethers.constants.MaxUint256,
      {
        value: nativeTokenAmount.mul(parseEther('0.5')).div(parseEther('1')),
      }
    );

  await router
    .connect(milo)
    .addLiquidityNativeToken(
      btc.address,
      false,
      parseEther('0.5'),
      0,
      0,
      milo.address,
      ethers.constants.MaxUint256,
      {
        value: nativeTokenAmount.mul(parseEther('0.5')).div(parseEther('1')),
      }
    );

  return {
    btc,
    dinero,
    alice,
    owner,
    bob,
    milo,
    treasury,
    priceOracle,
    lpFreeMarket,
    jose,
    router,
    volatilePair,
    ipx,
    casaDePapel,
    wnt,
  };
}

describe('LP Free Market', function () {
  describe('function: initialize(bytes,bytes)', function () {
    it('initializes the contract correctly', async () => {
      const { lpFreeMarket, ipx, volatilePair, router, owner, casaDePapel } =
        await loadFixture(deployFixture);

      expect(await lpFreeMarket.owner()).to.be.equal(owner.address);
      expect(
        await ipx.allowance(lpFreeMarket.address, casaDePapel.address)
      ).to.be.equal(ethers.constants.MaxUint256);
      expect(
        await volatilePair.allowance(lpFreeMarket.address, casaDePapel.address)
      ).to.be.equal(ethers.constants.MaxUint256);
      expect(
        await volatilePair.allowance(lpFreeMarket.address, router.address)
      ).to.be.equal(ethers.constants.MaxUint256);
    });

    it('reverts if you try to initialize the contract again', async () => {
      const { lpFreeMarket } = await loadFixture(deployFixture);

      await expect(
        lpFreeMarket.initialize(
          ethers.constants.HashZero,
          ethers.constants.HashZero
        )
      ).to.revertedWith('Initializable: contract is already initialized');
    });
  });

  describe('function: getCollateralEarnings()', function () {
    it('does nothing if there are no earnings', async () => {
      const { lpFreeMarket, volatilePair } = await loadFixture(deployFixture);

      expect(await lpFreeMarket.collateralEarnings()).to.be.equal(0);

      await expect(lpFreeMarket.getCollateralEarnings())
        .to.not.emit(lpFreeMarket, 'GetCollateralEarnings')
        .to.not.emit(volatilePair, 'Transfer');
    });

    it('sends the earnings to the treasury', async () => {
      const { lpFreeMarket, volatilePair, alice, treasury } = await loadFixture(
        deployFixture
      );

      await lpFreeMarket.setCollateralEarnings(parseEther('0.5'));

      expect(await lpFreeMarket.collateralEarnings()).to.be.equal(
        parseEther('0.5')
      );

      await volatilePair
        .connect(alice)
        .transfer(lpFreeMarket.address, parseEther('0.5'));

      await expect(lpFreeMarket.getCollateralEarnings())
        .to.emit(lpFreeMarket, 'GetCollateralEarnings')
        .withArgs(treasury.address, parseEther('0.5'))
        .to.emit(volatilePair, 'Transfer')
        .withArgs(lpFreeMarket.address, treasury.address, parseEther('0.5'));

      expect(await lpFreeMarket.collateralEarnings()).to.be.equal(0);
    });
  });

  describe('function: compound()', function () {
    it('compounds the rewards', async () => {
      const { lpFreeMarket, ipx, alice, owner, casaDePapel } =
        await loadFixture(deployFixture);

      expect(await lpFreeMarket.totalRewardsPerToken()).to.be.equal(0);

      await lpFreeMarket
        .connect(alice)
        .deposit(alice.address, ALICE_LP_BALANCE.div(2));

      await mine(10);

      await lpFreeMarket
        .connect(alice)
        .deposit(alice.address, ALICE_LP_BALANCE.div(2));

      const totalRewardsPerToken = await lpFreeMarket.totalRewardsPerToken();

      expect(totalRewardsPerToken.gt(0)).to.be.equal(true);

      await expect(lpFreeMarket.compound())
        .to.emit(lpFreeMarket, 'Compound')
        .to.emit(ipx, 'Transfer')
        .withArgs(lpFreeMarket.address, owner.address, anyUint)
        .to.emit(casaDePapel, 'Stake')
        .withArgs(lpFreeMarket.address, 0, anyUint)
        .to.emit(casaDePapel, 'Stake')
        .withArgs(lpFreeMarket.address, 1, anyUint)
        .to.emit(casaDePapel, 'Unstake')
        .withArgs(lpFreeMarket.address, 0, anyUint);

      expect(await ipx.balanceOf(lpFreeMarket.address)).to.be.equal(0);
    });
  });

  describe('function: deposit(address,uint256)', function () {
    it('reverts if you pass invalid arguments', async () => {
      const { lpFreeMarket, owner } = await loadFixture(deployFixture);

      await expect(lpFreeMarket.deposit(owner.address, 0)).to.rejectedWith(
        'LPFreeMarket__InvalidAmount()'
      );

      await expect(
        lpFreeMarket.deposit(ethers.constants.AddressZero, 1)
      ).to.rejectedWith('LPFreeMarket__InvalidAddress()');
    });

    it('first deposits does not update the rewards', async () => {
      const { lpFreeMarket, alice, owner, volatilePair, casaDePapel } =
        await loadFixture(deployFixture);

      await expect(
        lpFreeMarket.connect(alice).deposit(owner.address, parseEther('2'))
      )
        .to.emit(volatilePair, 'Transfer')
        .withArgs(alice.address, lpFreeMarket.address, parseEther('2'))
        .to.emit(casaDePapel, 'Stake')
        .withArgs(lpFreeMarket.address, 1, parseEther('2'))
        .to.emit(lpFreeMarket, 'Deposit')
        .withArgs(alice.address, owner.address, parseEther('2'));

      const [
        ownerAccount,
        aliceAccount,
        totalCollateral,
        totalRewardsPerToken,
      ] = await Promise.all([
        lpFreeMarket.accountOf(owner.address),
        lpFreeMarket.accountOf(alice.address),
        lpFreeMarket.totalCollateral(),
        lpFreeMarket.totalRewardsPerToken(),
      ]);

      expect(totalCollateral).to.be.equal(parseEther('2'));
      expect(totalRewardsPerToken).to.be.equal(0);
      expect(ownerAccount.collateral).to.be.equal(parseEther('2'));
      expect(ownerAccount.rewards).to.be.equal(0);
      expect(ownerAccount.rewardDebt).to.be.equal(0);
      expect(aliceAccount.collateral).to.be.equal(0);
      expect(aliceAccount.rewards).to.be.equal(0);
      expect(aliceAccount.rewardDebt).to.be.equal(0);
    });

    it('correctly calculates rewards on multiple deposits', async () => {
      const { lpFreeMarket, alice, bob, ipx } = await loadFixture(
        deployFixture
      );

      await lpFreeMarket.connect(alice).deposit(alice.address, parseEther('2'));

      await mine(10);

      await lpFreeMarket.connect(bob).deposit(bob.address, parseEther('1'));

      const [bobAccount, totalCollateral, totalRewardsPerToken, ipxSupply] =
        await Promise.all([
          lpFreeMarket.accountOf(bob.address),
          lpFreeMarket.totalCollateral(),
          lpFreeMarket.totalRewardsPerToken(),
          ipx.totalSupply(),
        ]);

      expect(bobAccount.collateral).to.be.equal(parseEther('1'));
      expect(bobAccount.rewards).to.be.equal(0);
      expect(bobAccount.rewardDebt).to.be.equal(totalRewardsPerToken);
      expect(totalCollateral).to.be.equal(parseEther('3'));
      expect(totalRewardsPerToken).to.be.equal(
        ipxSupply.mul(parseEther('1')).div(parseEther('2'))
      );

      await mine(5);

      await lpFreeMarket.connect(alice).deposit(alice.address, parseEther('1'));

      const [
        aliceAccount2,
        totalCollateral2,
        totalRewardsPerToken2,
        ipxSupply2,
      ] = await Promise.all([
        lpFreeMarket.accountOf(alice.address),
        lpFreeMarket.totalCollateral(),
        lpFreeMarket.totalRewardsPerToken(),
        ipx.totalSupply(),
      ]);

      expect(aliceAccount2.collateral).to.be.equal(parseEther('3'));
      expect(aliceAccount2.rewards).to.be.equal(
        totalRewardsPerToken2.mul(parseEther('2')).div(parseEther('1'))
      );
      expect(aliceAccount2.rewardDebt).to.be.equal(
        totalRewardsPerToken2.mul(parseEther('3')).div(parseEther('1'))
      );
      expect(totalCollateral2).to.be.equal(parseEther('4'));
      expect(totalRewardsPerToken2).to.be.equal(
        ipxSupply2
          .sub(ipxSupply)
          .mul(parseEther('1'))
          .div(parseEther('3'))
          .add(totalRewardsPerToken)
      );
    });
  });

  describe('function: withdraw(address,uint256)', function () {
    it('reverts if you pass invalid arguments', async () => {
      const { lpFreeMarket, alice } = await loadFixture(deployFixture);

      await expect(
        lpFreeMarket.withdraw(ethers.constants.AddressZero, 0)
      ).to.rejectedWith('LPFreeMarket__InvalidAmount()');

      await lpFreeMarket.connect(alice).deposit(alice.address, parseEther('1'));

      await expect(
        lpFreeMarket
          .connect(alice)
          .withdraw(ethers.constants.AddressZero, parseEther('1').add(1))
      ).to.rejectedWith('LPFreeMarket__InvalidWithdrawAmount()');
    });

    it('reverts if the user is insolvent', async () => {
      const { lpFreeMarket, alice, priceOracle, volatilePair } =
        await loadFixture(deployFixture);

      await lpFreeMarket.connect(alice).deposit(alice.address, parseEther('2'));

      await lpFreeMarket
        .connect(alice)
        .borrow(alice.address, LP_TOKEN_USD_PRICE);

      const priceFeed = await deploy('PriceFeed');

      await priceFeed.setPrice(LP_TOKEN_USD_PRICE.sub(1));

      await priceOracle.setUSDFeed(volatilePair.address, priceFeed.address);

      await expect(
        lpFreeMarket.connect(alice).withdraw(alice.address, 100)
      ).to.rejectedWith('LPFreeMarket__InsolventCaller()');
    });

    it('allows withdraws', async () => {
      const { lpFreeMarket, alice, bob, jose, volatilePair, ipx, casaDePapel } =
        await loadFixture(deployFixture);

      await lpFreeMarket.connect(alice).deposit(alice.address, parseEther('2'));

      const totalRewardsPerToken = await lpFreeMarket.totalRewardsPerToken();

      await mine(1);

      await lpFreeMarket.connect(bob).deposit(bob.address, parseEther('1'));

      const [totalRewardsPerToken2, ipxSupply2] = await Promise.all([
        lpFreeMarket.totalRewardsPerToken(),
        ipx.totalSupply(),
      ]);

      await mine(1);

      await expect(
        lpFreeMarket.connect(alice).withdraw(jose.address, parseEther('1'))
      )
        .to.emit(lpFreeMarket, 'Withdraw')
        .withArgs(alice.address, jose.address, parseEther('1'))
        .to.emit(volatilePair, 'Transfer')
        .withArgs(lpFreeMarket.address, jose.address, parseEther('1'))
        .to.emit(ipx, 'Transfer')
        .withArgs(lpFreeMarket.address, jose.address, anyUint)
        .to.emit(casaDePapel, 'Unstake')
        .withArgs(lpFreeMarket.address, 1, parseEther('1'))
        .to.emit(casaDePapel, 'Unstake')
        .withArgs(lpFreeMarket.address, 0, 0)
        .to.emit(casaDePapel, 'Stake')
        .withArgs(lpFreeMarket.address, 0, anyUint);

      const [
        totalRewardsPerToken3,
        ipxSupply3,
        aliceAccount3,
        bobAccount3,
        totalCollateral3,
        joseIPXBalance3,
      ] = await Promise.all([
        lpFreeMarket.totalRewardsPerToken(),
        ipx.totalSupply(),
        lpFreeMarket.accountOf(alice.address),
        lpFreeMarket.accountOf(bob.address),
        lpFreeMarket.totalCollateral(),
        ipx.balanceOf(jose.address),
      ]);

      expect(totalCollateral3).to.be.equal(parseEther('2'));

      expect(bobAccount3.collateral).to.be.equal(parseEther('1'));
      expect(bobAccount3.rewards).to.be.equal(0);
      expect(bobAccount3.rewardDebt).to.be.equal(totalRewardsPerToken2);

      expect(aliceAccount3.collateral).to.be.equal(parseEther('1'));
      expect(aliceAccount3.rewards).to.be.equal(0);
      expect(aliceAccount3.rewardDebt).to.be.equal(totalRewardsPerToken3);

      // alice withdraw went to jose
      expect(joseIPXBalance3).to.be.equal(
        totalRewardsPerToken3.mul(parseEther('2')).div(parseEther('1'))
      );

      expect(totalRewardsPerToken3).to.be.equal(
        ipxSupply3
          .sub(ipxSupply2)
          .mul(parseEther('1'))
          .div(parseEther('3'))
          .add(totalRewardsPerToken2)
          .add(totalRewardsPerToken)
      );
    });
  });

  describe('function: borrow(address,uint256)', function () {
    it('reverts if you borrow more than the maximum amount', async () => {
      const { lpFreeMarket, alice } = await loadFixture(deployFixture);

      await lpFreeMarket.setMaxBorrowAmount(parseEther('100'));

      await lpFreeMarket.connect(alice).deposit(alice.address, parseEther('2'));

      await expect(
        lpFreeMarket
          .connect(alice)
          .borrow(alice.address, parseEther('100').add(1))
      ).to.rejectedWith('LPFreeMarket__MaxBorrowAmountReached()');
    });

    it('reverts if you the user is insolvent', async () => {
      const { lpFreeMarket, alice } = await loadFixture(deployFixture);

      await lpFreeMarket.connect(alice).deposit(alice.address, parseEther('1'));

      await expect(
        lpFreeMarket
          .connect(alice)
          .borrow(alice.address, LP_TOKEN_USD_PRICE.div(2).add(1))
      ).to.rejectedWith('LPFreeMarket__InsolventCaller()');
    });

    it('allows a solvent user to borrow', async () => {
      const { lpFreeMarket, alice, dinero, owner } = await loadFixture(
        deployFixture
      );

      await lpFreeMarket.connect(alice).deposit(alice.address, parseEther('1'));

      await expect(
        lpFreeMarket
          .connect(alice)
          .borrow(owner.address, LP_TOKEN_USD_PRICE.div(2))
      )
        .to.emit(lpFreeMarket, 'Borrow')
        .withArgs(alice.address, owner.address, LP_TOKEN_USD_PRICE.div(2))
        .to.emit(dinero, 'Transfer')
        .withArgs(
          ethers.constants.AddressZero,
          owner.address,
          LP_TOKEN_USD_PRICE.div(2)
        );

      const [totalPrincipal, aliceAccount] = await Promise.all([
        lpFreeMarket.totalPrincipal(),
        lpFreeMarket.accountOf(alice.address),
      ]);

      expect(totalPrincipal).to.be.equal(LP_TOKEN_USD_PRICE.div(2));
      expect(aliceAccount.principal).to.be.equal(LP_TOKEN_USD_PRICE.div(2));
    });
  });

  describe('function: repay(address,uint256)', function () {
    it('allows repayments', async () => {
      const { lpFreeMarket, alice, dinero, owner } = await loadFixture(
        deployFixture
      );

      await lpFreeMarket.connect(alice).deposit(alice.address, parseEther('1'));

      await lpFreeMarket
        .connect(alice)
        .borrow(owner.address, LP_TOKEN_USD_PRICE.div(2));

      await expect(lpFreeMarket.repay(alice.address, parseEther('100')))
        .to.emit(lpFreeMarket, 'Repay')
        .withArgs(owner.address, alice.address, parseEther('100'))
        .to.emit(dinero, 'Transfer')
        .withArgs(
          owner.address,
          ethers.constants.AddressZero,
          parseEther('100')
        );

      const [totalPrincipal, aliceAccount] = await Promise.all([
        lpFreeMarket.totalPrincipal(),
        lpFreeMarket.accountOf(alice.address),
      ]);

      expect(totalPrincipal).to.be.equal(
        LP_TOKEN_USD_PRICE.div(2).sub(parseEther('100'))
      );
      expect(aliceAccount.principal).to.be.equal(
        LP_TOKEN_USD_PRICE.div(2).sub(parseEther('100'))
      );
    });
  });

  describe('function: request(uint256[],bytes[])', function () {
    it('reverts if an action is invalid', async () => {
      const { lpFreeMarket } = await loadFixture(deployFixture);

      await expect(
        lpFreeMarket.request([4], [ethers.constants.HashZero])
      ).to.rejectedWith('LPFreeMarket__InvalidRequest()');
    });

    describe('request: deposit', function () {
      it('reverts if you pass invalid arguments', async () => {
        const { lpFreeMarket, owner } = await loadFixture(deployFixture);

        await expect(
          lpFreeMarket.request(
            [DEPOSIT_REQUEST],
            [defaultAbiCoder.encode(['address', 'uint256'], [owner.address, 0])]
          )
        ).to.rejectedWith('LPFreeMarket__InvalidAmount()');

        await expect(
          lpFreeMarket.request(
            [DEPOSIT_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [ethers.constants.AddressZero, 1]
              ),
            ]
          )
        ).to.rejectedWith('LPFreeMarket__InvalidAddress()');
      });

      it('first deposits does not update the rewards', async () => {
        const { lpFreeMarket, alice, owner, volatilePair, casaDePapel } =
          await loadFixture(deployFixture);

        await expect(
          lpFreeMarket
            .connect(alice)
            .request(
              [DEPOSIT_REQUEST],
              [
                defaultAbiCoder.encode(
                  ['address', 'uint256'],
                  [owner.address, parseEther('2')]
                ),
              ]
            )
        )
          .to.emit(volatilePair, 'Transfer')
          .withArgs(alice.address, lpFreeMarket.address, parseEther('2'))
          .to.emit(casaDePapel, 'Stake')
          .withArgs(lpFreeMarket.address, 1, parseEther('2'))
          .to.emit(lpFreeMarket, 'Deposit')
          .withArgs(alice.address, owner.address, parseEther('2'));

        const [
          ownerAccount,
          aliceAccount,
          totalCollateral,
          totalRewardsPerToken,
        ] = await Promise.all([
          lpFreeMarket.accountOf(owner.address),
          lpFreeMarket.accountOf(alice.address),
          lpFreeMarket.totalCollateral(),
          lpFreeMarket.totalRewardsPerToken(),
        ]);

        expect(totalCollateral).to.be.equal(parseEther('2'));
        expect(totalRewardsPerToken).to.be.equal(0);
        expect(ownerAccount.collateral).to.be.equal(parseEther('2'));
        expect(ownerAccount.rewards).to.be.equal(0);
        expect(ownerAccount.rewardDebt).to.be.equal(0);
        expect(aliceAccount.collateral).to.be.equal(0);
        expect(aliceAccount.rewards).to.be.equal(0);
        expect(aliceAccount.rewardDebt).to.be.equal(0);
      });

      it('correctly calculates rewards on multiple deposits', async () => {
        const { lpFreeMarket, alice, bob, ipx } = await loadFixture(
          deployFixture
        );

        await lpFreeMarket
          .connect(alice)
          .request(
            [DEPOSIT_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [alice.address, parseEther('2')]
              ),
            ]
          );

        await mine(10);

        await lpFreeMarket
          .connect(bob)
          .request(
            [DEPOSIT_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [bob.address, parseEther('1')]
              ),
            ]
          );

        const [bobAccount, totalCollateral, totalRewardsPerToken, ipxSupply] =
          await Promise.all([
            lpFreeMarket.accountOf(bob.address),
            lpFreeMarket.totalCollateral(),
            lpFreeMarket.totalRewardsPerToken(),
            ipx.totalSupply(),
          ]);

        expect(bobAccount.collateral).to.be.equal(parseEther('1'));
        expect(bobAccount.rewards).to.be.equal(0);
        expect(bobAccount.rewardDebt).to.be.equal(totalRewardsPerToken);
        expect(totalCollateral).to.be.equal(parseEther('3'));
        expect(totalRewardsPerToken).to.be.equal(
          ipxSupply.mul(parseEther('1')).div(parseEther('2'))
        );

        await mine(5);

        await lpFreeMarket
          .connect(alice)
          .request(
            [DEPOSIT_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [alice.address, parseEther('1')]
              ),
            ]
          );

        const [
          aliceAccount2,
          totalCollateral2,
          totalRewardsPerToken2,
          ipxSupply2,
        ] = await Promise.all([
          lpFreeMarket.accountOf(alice.address),
          lpFreeMarket.totalCollateral(),
          lpFreeMarket.totalRewardsPerToken(),
          ipx.totalSupply(),
        ]);

        expect(aliceAccount2.collateral).to.be.equal(parseEther('3'));
        expect(aliceAccount2.rewards).to.be.equal(
          totalRewardsPerToken2.mul(parseEther('2')).div(parseEther('1'))
        );
        expect(aliceAccount2.rewardDebt).to.be.equal(
          totalRewardsPerToken2.mul(parseEther('3')).div(parseEther('1'))
        );
        expect(totalCollateral2).to.be.equal(parseEther('4'));
        expect(totalRewardsPerToken2).to.be.equal(
          ipxSupply2
            .sub(ipxSupply)
            .mul(parseEther('1'))
            .div(parseEther('3'))
            .add(totalRewardsPerToken)
        );
      });
    });

    describe('request: withdraw', function () {
      it('reverts if you pass invalid arguments', async () => {
        const { lpFreeMarket, alice } = await loadFixture(deployFixture);

        await expect(
          lpFreeMarket.request(
            [WITHDRAW_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [ethers.constants.AddressZero, 0]
              ),
            ]
          )
        ).to.rejectedWith('LPFreeMarket__InvalidAmount()');

        await expect(
          lpFreeMarket
            .connect(alice)
            .request(
              [DEPOSIT_REQUEST, WITHDRAW_REQUEST],
              [
                defaultAbiCoder.encode(
                  ['address', 'uint256'],
                  [alice.address, parseEther('1')]
                ),
                defaultAbiCoder.encode(
                  ['address', 'uint256'],
                  [ethers.constants.AddressZero, parseEther('1').add(1)]
                ),
              ]
            )
        ).to.rejectedWith('LPFreeMarket__InvalidWithdrawAmount()');
      });

      it('reverts if the user is insolvent', async () => {
        const { lpFreeMarket, alice, priceOracle, volatilePair } =
          await loadFixture(deployFixture);

        await lpFreeMarket
          .connect(alice)
          .request(
            [DEPOSIT_REQUEST, BORROW_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [alice.address, parseEther('2')]
              ),
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [alice.address, LP_TOKEN_USD_PRICE]
              ),
            ]
          );

        const priceFeed = await deploy('PriceFeed');

        await priceFeed.setPrice(LP_TOKEN_USD_PRICE.sub(1));

        await priceOracle.setUSDFeed(volatilePair.address, priceFeed.address);

        await expect(
          lpFreeMarket
            .connect(alice)
            .request(
              [WITHDRAW_REQUEST],
              [
                defaultAbiCoder.encode(
                  ['address', 'uint256'],
                  [alice.address, 1]
                ),
              ]
            )
        ).to.rejectedWith('LPFreeMarket__InsolventCaller()');
      });

      it('allows withdraws', async () => {
        const {
          lpFreeMarket,
          alice,
          bob,
          jose,
          volatilePair,
          ipx,
          casaDePapel,
        } = await loadFixture(deployFixture);

        await lpFreeMarket
          .connect(alice)
          .deposit(alice.address, parseEther('2'));

        const totalRewardsPerToken = await lpFreeMarket.totalRewardsPerToken();

        await mine(1);

        await lpFreeMarket.connect(bob).deposit(bob.address, parseEther('1'));

        const [totalRewardsPerToken2, ipxSupply2] = await Promise.all([
          lpFreeMarket.totalRewardsPerToken(),
          ipx.totalSupply(),
        ]);

        await mine(1);

        await expect(
          lpFreeMarket
            .connect(alice)
            .request(
              [WITHDRAW_REQUEST],
              [
                defaultAbiCoder.encode(
                  ['address', 'uint256'],
                  [jose.address, parseEther('1')]
                ),
              ]
            )
        )
          .to.emit(lpFreeMarket, 'Withdraw')
          .withArgs(alice.address, jose.address, parseEther('1'))
          .to.emit(volatilePair, 'Transfer')
          .withArgs(lpFreeMarket.address, jose.address, parseEther('1'))
          .to.emit(ipx, 'Transfer')
          .withArgs(lpFreeMarket.address, jose.address, anyUint)
          .to.emit(casaDePapel, 'Unstake')
          .withArgs(lpFreeMarket.address, 1, parseEther('1'))
          .to.emit(casaDePapel, 'Unstake')
          .withArgs(lpFreeMarket.address, 0, 0)
          .to.emit(casaDePapel, 'Stake')
          .withArgs(lpFreeMarket.address, 0, anyUint);

        const [
          totalRewardsPerToken3,
          ipxSupply3,
          aliceAccount3,
          bobAccount3,
          totalCollateral3,
          joseIPXBalance3,
        ] = await Promise.all([
          lpFreeMarket.totalRewardsPerToken(),
          ipx.totalSupply(),
          lpFreeMarket.accountOf(alice.address),
          lpFreeMarket.accountOf(bob.address),
          lpFreeMarket.totalCollateral(),
          ipx.balanceOf(jose.address),
        ]);

        expect(totalCollateral3).to.be.equal(parseEther('2'));

        expect(bobAccount3.collateral).to.be.equal(parseEther('1'));
        expect(bobAccount3.rewards).to.be.equal(0);
        expect(bobAccount3.rewardDebt).to.be.equal(totalRewardsPerToken2);

        expect(aliceAccount3.collateral).to.be.equal(parseEther('1'));
        expect(aliceAccount3.rewards).to.be.equal(0);
        expect(aliceAccount3.rewardDebt).to.be.equal(totalRewardsPerToken3);

        // alice withdraw went to jose
        expect(joseIPXBalance3).to.be.equal(
          totalRewardsPerToken3.mul(parseEther('2')).div(parseEther('1'))
        );

        expect(totalRewardsPerToken3).to.be.equal(
          ipxSupply3
            .sub(ipxSupply2)
            .mul(parseEther('1'))
            .div(parseEther('3'))
            .add(totalRewardsPerToken2)
            .add(totalRewardsPerToken)
        );
      });
    });

    describe('request: borrow', function () {
      it('reverts if you borrow more than the maximum amount', async () => {
        const { lpFreeMarket, alice } = await loadFixture(deployFixture);

        await lpFreeMarket.setMaxBorrowAmount(parseEther('100'));

        await lpFreeMarket
          .connect(alice)
          .deposit(alice.address, parseEther('2'));

        await expect(
          lpFreeMarket
            .connect(alice)
            .request(
              [DEPOSIT_REQUEST, BORROW_REQUEST],
              [
                defaultAbiCoder.encode(
                  ['address', 'uint256'],
                  [alice.address, parseEther('2')]
                ),
                defaultAbiCoder.encode(
                  ['address', 'uint256'],
                  [alice.address, parseEther('100').add(1)]
                ),
              ]
            )
        ).to.rejectedWith('LPFreeMarket__MaxBorrowAmountReached()');
      });

      it('reverts if you the user is insolvent', async () => {
        const { lpFreeMarket, alice } = await loadFixture(deployFixture);

        await expect(
          lpFreeMarket
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
                  [alice.address, LP_TOKEN_USD_PRICE.div(2).add(100)]
                ),
              ]
            )
        ).to.rejectedWith('LPFreeMarket__InsolventCaller()');
      });

      it('allows a solvent user to borrow', async () => {
        const { lpFreeMarket, alice, dinero, owner } = await loadFixture(
          deployFixture
        );

        await lpFreeMarket
          .connect(alice)
          .deposit(alice.address, parseEther('1'));

        await expect(
          lpFreeMarket
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
                  [owner.address, LP_TOKEN_USD_PRICE.div(2)]
                ),
              ]
            )
        )
          .to.emit(lpFreeMarket, 'Borrow')
          .withArgs(alice.address, owner.address, LP_TOKEN_USD_PRICE.div(2))
          .to.emit(dinero, 'Transfer')
          .withArgs(
            ethers.constants.AddressZero,
            owner.address,
            LP_TOKEN_USD_PRICE.div(2)
          );

        const [totalPrincipal, aliceAccount] = await Promise.all([
          lpFreeMarket.totalPrincipal(),
          lpFreeMarket.accountOf(alice.address),
        ]);

        expect(totalPrincipal).to.be.equal(LP_TOKEN_USD_PRICE.div(2));
        expect(aliceAccount.principal).to.be.equal(LP_TOKEN_USD_PRICE.div(2));
      });
    });

    describe('request: repay', function () {
      it('allows repayments', async () => {
        const { lpFreeMarket, alice, dinero, owner } = await loadFixture(
          deployFixture
        );

        await lpFreeMarket
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
                [owner.address, LP_TOKEN_USD_PRICE.div(2)]
              ),
            ]
          );

        await expect(
          lpFreeMarket.request(
            [REPAY_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [alice.address, parseEther('100')]
              ),
            ]
          )
        )
          .to.emit(lpFreeMarket, 'Repay')
          .withArgs(owner.address, alice.address, parseEther('100'))
          .to.emit(dinero, 'Transfer')
          .withArgs(
            owner.address,
            ethers.constants.AddressZero,
            parseEther('100')
          );

        const [totalPrincipal, aliceAccount] = await Promise.all([
          lpFreeMarket.totalPrincipal(),
          lpFreeMarket.accountOf(alice.address),
        ]);

        expect(totalPrincipal).to.be.equal(
          LP_TOKEN_USD_PRICE.div(2).sub(parseEther('100'))
        );
        expect(aliceAccount.principal).to.be.equal(
          LP_TOKEN_USD_PRICE.div(2).sub(parseEther('100'))
        );
      });
    });
  });

  describe('function: liquidate(address[],uint256[],address,bytes)', function () {
    it('reverts if there are no underwater positions', async () => {
      const { lpFreeMarket, alice, owner } = await loadFixture(deployFixture);

      await lpFreeMarket
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
              [alice.address, parseEther('1000')]
            ),
          ]
        );

      await expect(
        lpFreeMarket.liquidate(
          [alice.address],
          [parseEther('1000')],
          owner.address,
          []
        )
      ).to.rejectedWith('LPFreeMarket__InvalidLiquidationAmount()');
    });

    it('liquidates accounts without calling {sellTwoTokens}', async () => {
      const {
        lpFreeMarket,
        alice,
        milo,
        bob,
        volatilePair,
        dinero,
        owner,
        btc,
        casaDePapel,
        ipx,
        wnt,
      } = await loadFixture(deployFixture);

      await Promise.all([
        lpFreeMarket
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
                [alice.address, parseEther('4000')]
              ),
            ]
          ),
        lpFreeMarket
          .connect(bob)
          .request(
            [DEPOSIT_REQUEST, BORROW_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [bob.address, parseEther('1')]
              ),
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [bob.address, parseEther('3000')]
              ),
            ]
          ),
        lpFreeMarket
          .connect(milo)
          .request(
            [DEPOSIT_REQUEST, BORROW_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [milo.address, parseEther('1')]
              ),
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [milo.address, parseEther('1000')]
              ),
            ]
          ),
      ]);

      // Alice and Bob are open to be liquidated
      await lpFreeMarket.setMaxLTVRatio(parseEther('0.3'));

      const recipient: Swap = await deploy('Swap');

      const [
        marketCasaDePapelAccount,
        aliceAccount,
        bobAccount,
        miloAccount,
        totalPrincipal,
        ownerDNRBalance,
      ] = await Promise.all([
        casaDePapel.userInfo(1, lpFreeMarket.address),
        lpFreeMarket.accountOf(alice.address),
        lpFreeMarket.accountOf(bob.address),
        lpFreeMarket.accountOf(milo.address),
        lpFreeMarket.totalPrincipal(),
        dinero.balanceOf(owner.address),
        volatilePair.balanceOf(recipient.address),
      ]);

      expect(marketCasaDePapelAccount.amount).to.be.equal(parseEther('3'));

      expect(aliceAccount.collateral).to.be.equal(parseEther('1'));
      expect(aliceAccount.principal).to.be.equal(parseEther('4000'));

      expect(bobAccount.collateral).to.be.equal(parseEther('1'));
      expect(bobAccount.principal).to.be.equal(parseEther('3000'));

      expect(miloAccount.collateral).to.be.equal(parseEther('1'));
      expect(miloAccount.principal).to.be.equal(parseEther('1000'));

      expect(totalPrincipal).to.be.equal(parseEther('8000'));

      await time.increase(ONE_MONTH_IN_SECONDS);
      await mine(1);

      const aliceCollateralToCover = aliceAccount.principal
        .mul(parseEther('1'))
        .div(LP_TOKEN_USD_PRICE);

      const bobCollateralToCover = parseEther('2500')
        .mul(parseEther('1'))
        .div(LP_TOKEN_USD_PRICE);

      const aliceFee = aliceCollateralToCover
        .mul(LIQUIDATION_FEE)
        .div(parseEther('1'));

      const bobFee = bobCollateralToCover
        .mul(LIQUIDATION_FEE)
        .div(parseEther('1'));

      const protocolFee = bobFee
        .add(aliceFee)
        .mul(parseEther('0.1'))
        .div(parseEther('1'));

      await expect(
        lpFreeMarket.liquidate(
          [alice.address, bob.address, milo.address],
          [
            ethers.constants.MaxUint256,
            parseEther('2500'),
            ethers.constants.MaxUint256,
          ],
          recipient.address,
          []
        )
      )
        .to.emit(volatilePair, 'Transfer')
        .withArgs(
          lpFreeMarket.address,
          recipient.address,
          aliceCollateralToCover
            .add(bobCollateralToCover)
            .add(bobFee.add(aliceFee).sub(protocolFee))
        )
        .to.emit(dinero, 'Transfer')
        .withArgs(
          owner.address,
          ethers.constants.AddressZero,
          parseEther('6500')
        )
        .to.emit(lpFreeMarket, 'Liquidate')
        .withArgs(
          owner.address,
          alice.address,
          aliceAccount.principal,
          aliceCollateralToCover,
          aliceFee
        )
        .to.emit(lpFreeMarket, 'Liquidate')
        .withArgs(
          owner.address,
          bob.address,
          parseEther('2500'),
          bobCollateralToCover,
          bobFee
        )
        .to.emit(ipx, 'Transfer')
        .withArgs(lpFreeMarket.address, alice.address, anyUint)
        .to.emit(ipx, 'Transfer')
        .withArgs(lpFreeMarket.address, bob.address, anyUint);

      const [
        marketCasaDePapelAccount2,
        aliceAccount2,
        bobAccount2,
        miloAccount2,
        totalPrincipal2,
        ownerDNRBalance2,
        recipientBTCBalance2,
        recipientWNTBalance2,
        marketVolatilePairBalance2,
        collateralEarnings2,
      ] = await Promise.all([
        casaDePapel.userInfo(1, lpFreeMarket.address),
        lpFreeMarket.accountOf(alice.address),
        lpFreeMarket.accountOf(bob.address),
        lpFreeMarket.accountOf(milo.address),
        lpFreeMarket.totalPrincipal(),
        dinero.balanceOf(owner.address),
        btc.balanceOf(recipient.address),
        wnt.balanceOf(recipient.address),
        volatilePair.balanceOf(lpFreeMarket.address),
        lpFreeMarket.collateralEarnings(),
      ]);

      expect(totalPrincipal2).to.be.equal(
        totalPrincipal.sub(parseEther('6500'))
      );
      expect(ownerDNRBalance2).to.be.equal(
        ownerDNRBalance.sub(parseEther('6500'))
      );

      expect(recipientBTCBalance2).to.be.equal(0);
      expect(recipientWNTBalance2).to.be.equal(0);

      expect(miloAccount2.principal).to.be.equal(miloAccount.principal);
      expect(miloAccount2.collateral).to.be.equal(miloAccount.collateral);

      expect(bobAccount2.principal).to.be.equal(
        bobAccount.principal.sub(parseEther('2500'))
      );
      expect(bobAccount2.collateral).to.be.equal(
        miloAccount.collateral.sub(bobCollateralToCover.add(bobFee))
      );

      expect(aliceAccount2.principal).to.be.equal(0);
      expect(aliceAccount2.collateral).to.be.equal(
        aliceAccount.collateral.sub(aliceCollateralToCover.add(aliceFee))
      );

      expect(marketCasaDePapelAccount2.amount).to.be.equal(
        marketCasaDePapelAccount.amount.sub(
          bobCollateralToCover
            .add(aliceCollateralToCover)
            .add(bobFee)
            .add(aliceFee)
        )
      );

      expect(marketVolatilePairBalance2).to.be.equal(protocolFee);
      expect(collateralEarnings2).to.be.equal(protocolFee);
    });

    it('liquidates accounts and calls {sellTwoTokens}', async () => {
      const {
        lpFreeMarket,
        alice,
        milo,
        bob,
        volatilePair,
        dinero,
        owner,
        btc,
        casaDePapel,
        ipx,
        router,
        wnt,
      } = await loadFixture(deployFixture);

      await Promise.all([
        lpFreeMarket
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
                [alice.address, parseEther('4000')]
              ),
            ]
          ),
        lpFreeMarket
          .connect(bob)
          .request(
            [DEPOSIT_REQUEST, BORROW_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [bob.address, parseEther('1')]
              ),
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [bob.address, parseEther('3000')]
              ),
            ]
          ),
        lpFreeMarket
          .connect(milo)
          .request(
            [DEPOSIT_REQUEST, BORROW_REQUEST],
            [
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [milo.address, parseEther('1')]
              ),
              defaultAbiCoder.encode(
                ['address', 'uint256'],
                [milo.address, parseEther('1000')]
              ),
            ]
          ),
      ]);

      // Alice and Bob are open to be liquidated
      await lpFreeMarket.setMaxLTVRatio(parseEther('0.3'));

      const recipient: Swap = await deploy('Swap');

      const [
        marketCasaDePapelAccount,
        aliceAccount,
        bobAccount,
        miloAccount,
        totalPrincipal,
        ownerDNRBalance,
      ] = await Promise.all([
        casaDePapel.userInfo(1, lpFreeMarket.address),
        lpFreeMarket.accountOf(alice.address),
        lpFreeMarket.accountOf(bob.address),
        lpFreeMarket.accountOf(milo.address),
        lpFreeMarket.totalPrincipal(),
        dinero.balanceOf(owner.address),
        volatilePair.balanceOf(recipient.address),
      ]);

      expect(marketCasaDePapelAccount.amount).to.be.equal(parseEther('3'));

      expect(aliceAccount.collateral).to.be.equal(parseEther('1'));
      expect(aliceAccount.principal).to.be.equal(parseEther('4000'));

      expect(bobAccount.collateral).to.be.equal(parseEther('1'));
      expect(bobAccount.principal).to.be.equal(parseEther('3000'));

      expect(miloAccount.collateral).to.be.equal(parseEther('1'));
      expect(miloAccount.principal).to.be.equal(parseEther('1000'));

      expect(totalPrincipal).to.be.equal(parseEther('8000'));

      await time.increase(ONE_MONTH_IN_SECONDS);
      await mine(1);

      const aliceCollateralToCover = aliceAccount.principal
        .mul(parseEther('1'))
        .div(LP_TOKEN_USD_PRICE);

      const bobCollateralToCover = parseEther('2500')
        .mul(parseEther('1'))
        .div(LP_TOKEN_USD_PRICE);

      const aliceFee = aliceCollateralToCover
        .mul(LIQUIDATION_FEE)
        .div(parseEther('1'));

      const bobFee = bobCollateralToCover
        .mul(LIQUIDATION_FEE)
        .div(parseEther('1'));

      const protocolFee = bobFee
        .add(aliceFee)
        .mul(parseEther('0.1'))
        .div(parseEther('1'));

      const removeLiquidityData = await router.quoteRemoveLiquidity(
        btc.address,
        wnt.address,
        false,
        aliceCollateralToCover
          .add(bobCollateralToCover)
          .add(bobFee.add(aliceFee).sub(protocolFee))
      );

      await expect(
        lpFreeMarket.liquidate(
          [alice.address, bob.address, milo.address],
          [
            ethers.constants.MaxUint256,
            parseEther('2500'),
            ethers.constants.MaxUint256,
          ],
          recipient.address,
          ethers.constants.HashZero
        )
      )
        .to.emit(dinero, 'Transfer')
        .withArgs(
          owner.address,
          ethers.constants.AddressZero,
          parseEther('6500')
        )
        .to.emit(lpFreeMarket, 'Liquidate')
        .withArgs(
          owner.address,
          alice.address,
          aliceAccount.principal,
          aliceCollateralToCover,
          aliceFee
        )
        .to.emit(lpFreeMarket, 'Liquidate')
        .withArgs(
          owner.address,
          bob.address,
          parseEther('2500'),
          bobCollateralToCover,
          bobFee
        )
        .to.emit(ipx, 'Transfer')
        .withArgs(lpFreeMarket.address, alice.address, anyUint)
        .to.emit(ipx, 'Transfer')
        .withArgs(lpFreeMarket.address, bob.address, anyUint)
        .to.emit(btc, 'Transfer')
        .withArgs(
          volatilePair.address,
          recipient.address,
          removeLiquidityData.amountA
        )
        .to.emit(wnt, 'Transfer')
        .withArgs(
          volatilePair.address,
          recipient.address,
          removeLiquidityData.amountB
        );

      const [
        marketCasaDePapelAccount2,
        aliceAccount2,
        bobAccount2,
        miloAccount2,
        totalPrincipal2,
        ownerDNRBalance2,
        marketVolatilePairBalance2,
        collateralEarnings2,
        recipientVolatilePairBalance2,
      ] = await Promise.all([
        casaDePapel.userInfo(1, lpFreeMarket.address),
        lpFreeMarket.accountOf(alice.address),
        lpFreeMarket.accountOf(bob.address),
        lpFreeMarket.accountOf(milo.address),
        lpFreeMarket.totalPrincipal(),
        dinero.balanceOf(owner.address),
        volatilePair.balanceOf(lpFreeMarket.address),
        lpFreeMarket.collateralEarnings(),
        volatilePair.balanceOf(recipient.address),
      ]);

      expect(totalPrincipal2).to.be.equal(
        totalPrincipal.sub(parseEther('6500'))
      );
      expect(ownerDNRBalance2).to.be.equal(
        ownerDNRBalance.sub(parseEther('6500'))
      );

      expect(recipientVolatilePairBalance2).to.be.equal(0);

      expect(miloAccount2.principal).to.be.equal(miloAccount.principal);
      expect(miloAccount2.collateral).to.be.equal(miloAccount.collateral);

      expect(bobAccount2.principal).to.be.equal(
        bobAccount.principal.sub(parseEther('2500'))
      );
      expect(bobAccount2.collateral).to.be.equal(
        miloAccount.collateral.sub(bobCollateralToCover.add(bobFee))
      );

      expect(aliceAccount2.principal).to.be.equal(0);
      expect(aliceAccount2.collateral).to.be.equal(
        aliceAccount.collateral.sub(aliceCollateralToCover.add(aliceFee))
      );

      expect(marketCasaDePapelAccount2.amount).to.be.equal(
        marketCasaDePapelAccount.amount.sub(
          bobCollateralToCover
            .add(aliceCollateralToCover)
            .add(bobFee)
            .add(aliceFee)
        )
      );

      expect(marketVolatilePairBalance2).to.be.equal(protocolFee);
      expect(collateralEarnings2).to.be.equal(protocolFee);
    });
  });

  describe('Upgrade functionality', function () {
    it('reverts if it is not upgraded by the owner', async () => {
      const { lpFreeMarket } = await loadFixture(deployFixture);

      await lpFreeMarket.renounceOwnership();

      await expect(upgrade(lpFreeMarket, 'LPFreeMarketV2')).to.be.revertedWith(
        'Ownable: caller is not the owner'
      );
    });

    it('upgrades to version 2', async () => {
      const { lpFreeMarket, alice } = await loadFixture(deployFixture);

      await lpFreeMarket.connect(alice).deposit(alice.address, parseEther('2'));

      expect(
        (await lpFreeMarket.accountOf(alice.address)).collateral
      ).to.be.equal(parseEther('2'));

      const lpFreeMarketV2: LPFreeMarketV2 = await upgrade(
        lpFreeMarket,
        'LPFreeMarketV2'
      );

      const [version, aliceAccount] = await Promise.all([
        lpFreeMarketV2.version(),
        lpFreeMarketV2.accountOf(alice.address),
      ]);

      expect(version).to.be.equal('v2');
      expect(aliceAccount.collateral).to.be.equal(parseEther('2'));
    });
  });

  describe('function: setMaxLTVRatio', function () {
    it('reverts if it is not called by the owner', async () => {
      const { lpFreeMarket, alice } = await loadFixture(deployFixture);

      await expect(
        lpFreeMarket.connect(alice).setMaxLTVRatio(1)
      ).to.revertedWith('Ownable: caller is not the owner');
    });

    it('allows a maximum ltv of 90%', async () => {
      const { lpFreeMarket } = await loadFixture(deployFixture);

      expect(await lpFreeMarket.maxLTVRatio()).to.be.equal(parseEther('0.5'));

      await expect(lpFreeMarket.setMaxLTVRatio(parseEther('0.9'))).to.emit(
        lpFreeMarket,
        'MaxTVLRatio'
      );

      expect(await lpFreeMarket.maxLTVRatio()).to.be.equal(parseEther('0.9'));

      await expect(
        lpFreeMarket.setMaxLTVRatio(parseEther('0.91'))
      ).to.be.rejectedWith('LPFreeMarket__InvalidMaxLTVRatio()');
    });
  });

  describe('function: setLiquidationFee', function () {
    it('reverts if it is not called by the owner', async () => {
      const { lpFreeMarket, alice } = await loadFixture(deployFixture);

      await expect(
        lpFreeMarket.connect(alice).setLiquidationFee(1)
      ).to.revertedWith('Ownable: caller is not the owner');
    });

    it('allows a maximum fee of 15%', async () => {
      const { lpFreeMarket } = await loadFixture(deployFixture);

      expect(await lpFreeMarket.liquidationFee()).to.be.equal(
        parseEther('0.1')
      );

      await expect(lpFreeMarket.setLiquidationFee(parseEther('0.15'))).to.emit(
        lpFreeMarket,
        'LiquidationFee'
      );

      expect(await lpFreeMarket.liquidationFee()).to.be.equal(
        parseEther('0.15')
      );

      await expect(
        lpFreeMarket.setLiquidationFee(parseEther('0.151'))
      ).to.be.rejectedWith('LPFreeMarket__InvalidLiquidationFee()');
    });
  });

  describe('function: setTreasury', function () {
    it('reverts if it is not called by the owner', async () => {
      const { lpFreeMarket, alice } = await loadFixture(deployFixture);

      await expect(
        lpFreeMarket.connect(alice).setTreasury(ethers.constants.AddressZero)
      ).to.revertedWith('Ownable: caller is not the owner');
    });

    it('allows the treasury to be addressed', async () => {
      const { lpFreeMarket, treasury } = await loadFixture(deployFixture);

      expect(await lpFreeMarket.treasury()).to.be.equal(treasury.address);

      await expect(
        lpFreeMarket.setTreasury(ethers.constants.AddressZero)
      ).to.emit(lpFreeMarket, 'NewTreasury');

      expect(await lpFreeMarket.treasury()).to.be.equal(
        ethers.constants.AddressZero
      );
    });
  });

  describe('function: setMaxBorrowAmount', function () {
    it('reverts if it is not called by the owner', async () => {
      const { lpFreeMarket, alice } = await loadFixture(deployFixture);

      await expect(
        lpFreeMarket.connect(alice).setMaxBorrowAmount(0)
      ).to.revertedWith('Ownable: caller is not the owner');
    });

    it('updates the max borrow amount', async () => {
      const { lpFreeMarket } = await loadFixture(deployFixture);

      expect(await lpFreeMarket.maxBorrowAmount()).to.be.equal(
        parseEther('1000000')
      );

      await expect(lpFreeMarket.setMaxBorrowAmount(0)).to.emit(
        lpFreeMarket,
        'MaxBorrowAmount'
      );

      expect(await lpFreeMarket.maxBorrowAmount()).to.be.equal(0);
    });
  });
}).timeout(100000);
