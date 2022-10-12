import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers, network } from 'hardhat';

import { ERC20Fees } from '../typechain-types';
import {
  deploy,
  getDigest,
  getECSign,
  getPairDomainSeparator,
  PRIVATE_KEYS,
} from './utils';

const { parseEther } = ethers.utils;

const TRANSFER_FEE = parseEther('0.1');

async function deployFixture() {
  const [owner, alice, bob, treasury] = await ethers.getSigners();

  const erc20Fees: ERC20Fees = await deploy('ERC20Fees', [
    'Interest Brazilian Real',
    'iBRL',
    treasury.address,
    TRANSFER_FEE,
  ]);

  await Promise.all([
    erc20Fees.mint(owner.address, parseEther('1000')),
    erc20Fees.mint(alice.address, parseEther('1000')),
  ]);

  return {
    owner,
    alice,
    bob,
    treasury,
    erc20Fees,
  };
}

describe('ERC20Fees', function () {
  it('has ERC20 Metadata', async function () {
    const { erc20Fees } = await loadFixture(deployFixture);

    const [name, symbol, decimals] = await Promise.all([
      erc20Fees.name(),
      erc20Fees.symbol(),
      erc20Fees.decimals(),
    ]);

    expect(name).to.be.equal('Interest Brazilian Real');
    expect(symbol).to.be.equal('iBRL');
    expect(decimals).to.be.equal(18);
  });

  it('has fees state', async function () {
    const { erc20Fees, owner, treasury } = await loadFixture(deployFixture);

    const [deployer, _treasury, transferFee] = await Promise.all([
      erc20Fees.DEPLOYER_CONTRACT(),
      erc20Fees.treasury(),
      erc20Fees.transferFee(),
    ]);

    expect(deployer).to.be.equal(owner.address);
    expect(_treasury).to.be.equal(treasury.address);
    expect(transferFee).to.be.equal(TRANSFER_FEE);
  });

  it('allows users to give allowance to others', async () => {
    const { erc20Fees, alice, bob } = await loadFixture(deployFixture);

    expect(await erc20Fees.allowance(alice.address, bob.address)).to.be.equal(
      0
    );

    await expect(erc20Fees.connect(alice).approve(bob.address, 1000))
      .to.emit(erc20Fees, 'Approval')
      .withArgs(alice.address, bob.address, 1000);

    expect(await erc20Fees.allowance(alice.address, bob.address)).to.be.equal(
      1000
    );
  });

  it('allows users to transfer tokens with a fee', async () => {
    const { erc20Fees, alice, bob } = await loadFixture(deployFixture);

    const [aliceBalance, bobBalance, totalSupply] = await Promise.all([
      erc20Fees.balanceOf(alice.address),
      erc20Fees.balanceOf(bob.address),
      erc20Fees.totalSupply(),
    ]);

    expect(bobBalance).to.be.equal(0);
    expect(aliceBalance).to.be.equal(parseEther('1000'));
    expect(totalSupply).to.be.equal(parseEther('2000'));

    await expect(
      erc20Fees.connect(alice).transfer(bob.address, parseEther('10'))
    )
      .to.emit(erc20Fees, 'Transfer')
      .withArgs(alice.address, bob.address, parseEther('9'))
      .to.emit(erc20Fees, 'Transfer')
      .withArgs(alice.address, ethers.constants.AddressZero, parseEther('1'));

    const [aliceBalance2, bobBalance2, totalSupply2] = await Promise.all([
      erc20Fees.balanceOf(alice.address),
      erc20Fees.balanceOf(bob.address),
      erc20Fees.totalSupply(),
    ]);

    expect(bobBalance2).to.be.equal(parseEther('9'));
    expect(aliceBalance2).to.be.equal(aliceBalance.sub(parseEther('10')));
    expect(totalSupply2).to.be.equal(totalSupply.sub(parseEther('1')));

    await expect(
      erc20Fees.connect(bob).transfer(alice.address, parseEther('10.01'))
    ).to.be.reverted;
  });

  it('allows the deployer to transfer with no fees', async function () {
    const { erc20Fees, owner, bob } = await loadFixture(deployFixture);

    const totalSupply = await erc20Fees.totalSupply();

    await expect(erc20Fees.transfer(bob.address, parseEther('10')))
      .to.emit(erc20Fees, 'Transfer')
      .withArgs(owner.address, bob.address, parseEther('10'));

    expect(await erc20Fees.totalSupply()).to.be.equal(totalSupply);
    expect(await erc20Fees.balanceOf(bob.address)).to.be.equal(
      parseEther('10')
    );
  });

  it('allows a user to spend his/her allowance', async () => {
    const { erc20Fees, owner, alice, bob } = await loadFixture(deployFixture);

    await erc20Fees.connect(alice).approve(bob.address, parseEther('10'));

    // overspend his allowance
    await expect(
      erc20Fees
        .connect(bob)
        .transferFrom(alice.address, owner.address, parseEther('10.1'))
    ).to.be.reverted;

    const [aliceBalance, ownerBalance, bobAllowance] = await Promise.all([
      erc20Fees.balanceOf(alice.address),
      erc20Fees.balanceOf(owner.address),
      erc20Fees.allowance(alice.address, bob.address),
    ]);

    expect(bobAllowance).to.be.equal(parseEther('10'));
    expect(ownerBalance).to.be.equal(parseEther('1000'));

    await expect(
      erc20Fees
        .connect(bob)
        .transferFrom(alice.address, owner.address, parseEther('10'))
    )
      .to.emit(erc20Fees, 'Transfer')
      .withArgs(alice.address, owner.address, parseEther('9'))
      .to.emit(erc20Fees, 'Transfer')
      .withArgs(alice.address, ethers.constants.AddressZero, parseEther('1'));

    const [aliceBalance2, ownerBalance2, bobAllowance2] = await Promise.all([
      erc20Fees.balanceOf(alice.address),
      erc20Fees.balanceOf(owner.address),
      erc20Fees.allowance(alice.address, bob.address),
    ]);

    expect(bobAllowance2).to.be.equal(0);
    expect(ownerBalance2).to.be.equal(parseEther('9').add(ownerBalance));
    expect(aliceBalance2).to.be.equal(aliceBalance.sub(parseEther('10')));

    await erc20Fees
      .connect(alice)
      .approve(bob.address, ethers.constants.MaxUint256);

    await expect(
      erc20Fees
        .connect(bob)
        .transferFrom(alice.address, owner.address, parseEther('10'))
    )
      .to.emit(erc20Fees, 'Transfer')
      .withArgs(alice.address, owner.address, parseEther('9'))
      .to.emit(erc20Fees, 'Transfer')
      .withArgs(alice.address, ethers.constants.AddressZero, parseEther('1'));

    const [aliceBalance3, ownerBalance3, bobAllowance3] = await Promise.all([
      erc20Fees.balanceOf(alice.address),
      erc20Fees.balanceOf(owner.address),
      erc20Fees.allowance(alice.address, bob.address),
    ]);

    expect(bobAllowance3).to.be.equal(ethers.constants.MaxUint256);
    expect(ownerBalance3).to.be.equal(parseEther('9').add(ownerBalance2));
    expect(aliceBalance3).to.be.equal(aliceBalance2.sub(parseEther('10')));
  });

  it('reverts if the permit has expired', async () => {
    const { erc20Fees, alice, bob } = await loadFixture(deployFixture);

    const blockTimestamp = await (
      await ethers.provider.getBlock(await ethers.provider.getBlockNumber())
    ).timestamp;

    await expect(
      erc20Fees.permit(
        alice.address,
        bob.address,
        0,
        blockTimestamp - 1,
        0,
        ethers.constants.HashZero,
        ethers.constants.HashZero
      )
    ).to.revertedWithCustomError(erc20Fees, 'ERC20Fees__DeadlineExpired');
  });

  it('reverts if the recovered address is wrong', async () => {
    const chainId = network.config.chainId || 0;
    const { erc20Fees, owner, alice, bob } = await loadFixture(deployFixture);

    const name = await erc20Fees.name();
    const domainSeparator = getPairDomainSeparator(
      erc20Fees.address,
      name,
      chainId
    );

    const digest = getDigest(
      domainSeparator,
      alice.address,
      bob.address,
      parseEther('100'),
      0,
      1700587613
    );

    const { v, r, s } = getECSign(PRIVATE_KEYS[1], digest);

    const bobAllowance = await erc20Fees.allowance(alice.address, bob.address);

    expect(bobAllowance).to.be.equal(0);

    await Promise.all([
      expect(
        erc20Fees
          .connect(bob)
          .permit(
            owner.address,
            bob.address,
            parseEther('100'),
            1700587613,
            v,
            r,
            s
          )
      ).to.revertedWithCustomError(erc20Fees, 'ERC20Fees__InvalidSignature'),
      expect(
        erc20Fees
          .connect(bob)
          .permit(
            owner.address,
            bob.address,
            parseEther('100'),
            1700587613,
            0,
            ethers.constants.HashZero,
            ethers.constants.HashZero
          )
      ).to.revertedWithCustomError(erc20Fees, 'ERC20Fees__InvalidSignature'),
    ]);
  });

  it('allows only the deployer to mint new tokens', async () => {
    const { erc20Fees, owner, alice } = await loadFixture(deployFixture);

    await expect(
      erc20Fees.connect(alice).mint(alice.address, parseEther('1000'))
    ).revertedWithCustomError(erc20Fees, 'ERC20Fees__Unauthorized');

    await expect(erc20Fees.connect(owner).mint(alice.address, parseEther('10')))
      .to.emit(erc20Fees, 'Transfer')
      .withArgs(ethers.constants.AddressZero, alice.address, parseEther('10'));
  });

  it('allows only the deployer to burn tokens', async () => {
    const { erc20Fees, owner, alice } = await loadFixture(deployFixture);

    await expect(
      erc20Fees.connect(alice).burn(alice.address, parseEther('1000'))
    ).revertedWithCustomError(erc20Fees, 'ERC20Fees__Unauthorized');

    await expect(erc20Fees.connect(owner).burn(alice.address, parseEther('10')))
      .to.emit(erc20Fees, 'Transfer')
      .withArgs(alice.address, ethers.constants.AddressZero, parseEther('10'));
  });

  it('allows only the deployer to set a new treasury', async () => {
    const { erc20Fees, owner, alice, treasury } = await loadFixture(
      deployFixture
    );

    await expect(
      erc20Fees.connect(alice).setTreasury(alice.address)
    ).revertedWithCustomError(erc20Fees, 'ERC20Fees__Unauthorized');

    await expect(erc20Fees.connect(owner).setTreasury(owner.address))
      .to.emit(erc20Fees, 'TreasuryUpdated')
      .withArgs(treasury.address, owner.address);

    expect(await erc20Fees.treasury()).to.be.equal(owner.address);
  });

  it('allows only the deployer to set a new transferFee', async () => {
    const { erc20Fees, owner, alice } = await loadFixture(deployFixture);

    await expect(
      erc20Fees.connect(alice).setTransferFee(0)
    ).revertedWithCustomError(erc20Fees, 'ERC20Fees__Unauthorized');

    await expect(erc20Fees.connect(owner).setTransferFee(0))
      .to.emit(erc20Fees, 'TransferFeeUpdated')
      .withArgs(TRANSFER_FEE, 0);
  });

  it('allows only the owner to claim fees', async () => {
    const { erc20Fees, owner, alice, bob, treasury } = await loadFixture(
      deployFixture
    );

    await expect(erc20Fees.connect(alice).claimFees()).revertedWithCustomError(
      erc20Fees,
      'ERC20Fees__Unauthorized'
    );

    await erc20Fees.connect(alice).transfer(bob.address, parseEther('100'));

    const totalSupply = await erc20Fees.totalSupply();

    await expect(erc20Fees.connect(owner).claimFees())
      .to.emit(erc20Fees, 'Transfer')
      .withArgs(ethers.constants.AddressZero, owner.address, parseEther('8'))
      .to.emit(erc20Fees, 'Transfer')
      .withArgs(
        ethers.constants.AddressZero,
        treasury.address,
        parseEther('2')
      );

    expect(await erc20Fees.deployerBalance()).to.be.equal(0);
    expect(await erc20Fees.totalSupply()).to.be.equal(
      totalSupply.add(parseEther('10'))
    );
  });
});
