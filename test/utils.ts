import { ContractAddressOrInstance } from '@openzeppelin/hardhat-upgrades/dist/utils';
import { BigNumber } from 'ethers';
import { ethers, upgrades } from 'hardhat';
export const multiDeploy = async (
  x: ReadonlyArray<string>,
  y: Array<Array<unknown> | undefined> = []
): Promise<any> => {
  const contractFactories = await Promise.all(
    x.map((name) => ethers.getContractFactory(name))
  );

  return Promise.all(
    contractFactories.map((factory, index) =>
      factory.deploy(...(y[index] || []))
    )
  );
};

export const deploy = async (
  name: string,
  parameters: Array<unknown> = []
): Promise<any> => {
  const factory = await ethers.getContractFactory(name);
  return await factory.deploy(...parameters);
};

export const deployUUPS = async (
  name: string,
  parameters: Array<unknown> = []
): Promise<any> => {
  const factory = await ethers.getContractFactory(name);
  const instance = await upgrades.deployProxy(factory, parameters, {
    kind: 'uups',
  });
  await instance.deployed();
  return instance;
};

export const multiDeployUUPS = async (
  name: ReadonlyArray<string>,
  parameters: Array<Array<unknown> | undefined> = []
): Promise<any> => {
  const factories = await Promise.all(
    name.map((x) => ethers.getContractFactory(x))
  );

  const instances = await Promise.all(
    factories.map((factory, index) =>
      upgrades.deployProxy(factory, parameters[index], { kind: 'uups' })
    )
  );

  await Promise.all([instances.map((x) => x.deployed())]);

  return instances;
};

export const upgrade = async (
  proxy: ContractAddressOrInstance,
  name: string
): Promise<any> => {
  const factory = await ethers.getContractFactory(name);
  return upgrades.upgradeProxy(proxy, factory);
};

// Chainlink Feeds

export const BTC_USD_PRICE_FEED = '0x264990fbd0a4796a3e3d8e37c4d5f87a3aca5ebf';

export const ETHER_USD_PRICE_FEED =
  '0x9ef1b8c0e4f7dc8bf5719ea496883dc6401d5b2e';

const ONE = ethers.BigNumber.from(1);
const TWO = ethers.BigNumber.from(2);

export function sqrt(value: BigNumber) {
  const x = ethers.BigNumber.from(value);
  let z = x.add(ONE).div(TWO);
  let y = x;
  while (z.sub(y).isNegative()) {
    y = z;
    z = x.div(z).add(z).div(TWO);
  }
  return y;
}

export const MINTER_ROLE = ethers.utils.solidityKeccak256(
  ['string'],
  ['MINTER_ROLE']
);

export const DEVELOPER_ROLE = ethers.utils.solidityKeccak256(
  ['string'],
  ['DEVELOPER_ROLE']
);

export const DEPOSIT_REQUEST = 0;

export const WITHDRAW_REQUEST = 1;

export const BORROW_REQUEST = 2;

export const REPAY_REQUEST = 3;
