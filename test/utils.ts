import { ContractAddressOrInstance } from '@openzeppelin/hardhat-upgrades/dist/utils';
import { ecsign } from 'ethereumjs-util';
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

export const BNB_USD_PRICE_FEED = '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE';

export const BNB_USD_PRICE = ethers.BigNumber.from('417349361890000000000');

export const BTC_USD_PRICE = ethers.BigNumber.from('41629290000000000000000');

export const BRL_USD_PRICE = ethers.BigNumber.from('192496600000000000');

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

export const getPairDomainSeparator = (
  pairAddress: string,
  pairName: string,
  chainId: number
) =>
  ethers.utils.solidityKeccak256(
    ['bytes'],
    [
      ethers.utils.defaultAbiCoder.encode(
        ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
        [
          ethers.utils.solidityKeccak256(
            ['bytes'],
            [
              ethers.utils.toUtf8Bytes(
                'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
              ),
            ]
          ),
          ethers.utils.solidityKeccak256(
            ['bytes'],
            [ethers.utils.toUtf8Bytes(pairName)]
          ),
          ethers.utils.solidityKeccak256(
            ['bytes'],
            [ethers.utils.toUtf8Bytes('1')]
          ),
          chainId,
          pairAddress,
        ]
      ),
    ]
  );

export const getDigest = (
  domainSeparator: string,
  owner: string,
  spender: string,
  value: BigNumber,
  nonce: number,
  deadline: number
) =>
  ethers.utils.keccak256(
    ethers.utils.solidityPack(
      ['bytes1', 'bytes1', 'bytes32', 'bytes32'],
      [
        '0x19',
        '0x01',
        domainSeparator,
        ethers.utils.keccak256(
          ethers.utils.defaultAbiCoder.encode(
            ['bytes32', 'address', 'address', 'uint256', 'uint256', 'uint256'],
            [
              ethers.utils.keccak256(
                ethers.utils.toUtf8Bytes(
                  'Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)'
                )
              ),
              owner,
              spender,
              value.toString(),
              nonce,
              deadline,
            ]
          )
        ),
      ]
    )
  );

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

export const WRAPPED_NATIVE_TOKEN =
  '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';

// @desc follow the same order of the signers accounts
export const PRIVATE_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
];

export const getECSign = (privateKey: string, digest: string) =>
  ecsign(
    Buffer.from(digest.slice(2), 'hex'),
    Buffer.from(privateKey.replace('0x', ''), 'hex')
  );
