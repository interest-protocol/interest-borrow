// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";

import "@interest-protocol/library/MathLib.sol";
import "@interest-protocol/library/SafeCastLib.sol";
import "@interest-protocol/library/SafeTransferErrors.sol";
import "@interest-protocol/library/SafeTransferLib.sol";
import "@interest-protocol/earn/interfaces/ICasaDePapel.sol";

import "../interfaces/IPriceOracle.sol";
import "../interfaces/ISwap.sol";

import "./ERC20Fees.sol";
import "./ERC20Receipt.sol";

contract SyntheticManager is Ownable, SafeTransferErrors {
    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Libs                                 */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    using SafeTransferLib for address;
    using MathLib for uint256;
    using SafeCastLib for uint256;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Structs                              */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    struct AccountCollateral {
        uint32 syntsIn;
        uint224 collateral;
    }

    struct AccountSynt {
        uint256 synt;
        uint128 syntRewards;
        uint128 ipxRewards;
        uint256 syntRewardDebt;
        uint256 ipxRewardDebt;
    }

    struct SyntInfo {
        uint8 offset;
        bool whitelisted;
        uint240 totalSynt;
        uint96 poolId;
        address receipt;
        uint256 totalSyntRewardsPerToken;
        uint256 totalIPXRewardsPerToken;
    }

    struct LiquidationInfo {
        uint256 allCollateral;
        uint256 allSYNT;
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Events                               */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    event SyntAdded(address indexed synt, address indexed syntReceipt);

    event TreasuryUpdated(
        address indexed oldTreasury,
        address indexed newTreasury
    );

    event Deposit(address indexed from, address indexed to, uint256 amount);

    event Withdraw(address indexed from, address indexed to, uint256 amount);

    event Mint(
        address indexed synt,
        address indexed from,
        address indexed to,
        uint256 amount
    );

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Error                                */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    error SyntheticMarket__InvalidFee();

    error SyntheticMarket__InvalidExchangeRate();

    error SyntheticMarket__InsolventCaller();

    error SyntheticMarket__InvalidRequest();

    error SyntheticMarket__InvalidLiquidationAmount();

    error SyntheticMarket__InvalidSynt();

    error SyntheticMarket__MaxNumberOfSyntsReached();

    error SyntheticMarket__InvalidDebtCalculation();

    error SyntheticMarket__InvalidTransferFee();

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       No Slot                              */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    uint256 private constant DEPOSIT_REQUEST = 0;

    uint256 private constant WITHDRAW_REQUEST = 1;

    uint256 private constant MINT_REQUEST = 2;

    uint256 private constant BURN_REQUEST = 3;

    uint256 private constant SWAP_REQUEST = 4;

    uint256 private constant MAX_SYNT = 30;

    IPriceOracle private immutable ORACLE;

    address private immutable COLLATERAL;

    uint256 private immutable COLLATERAL_DECIMALS_FACTOR;

    ICasaDePapel private immutable CASA_DE_PAPEL;

    address private immutable IPX;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Slot 0                               */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    // User -> CollateralInfo
    mapping(address => AccountCollateral) public accountCollateralOf;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Slot 1                               */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    // Synt -> User -> SyntInfo
    mapping(address => mapping(address => AccountSynt)) public accountSyntOf;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Slot 2                               */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    // Synt -> SyntInfo
    mapping(address => SyntInfo) public syntInfoOf;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Slot 3                               */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    uint256 public maxLTV;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Slot 4                               */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    address public treasury;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Slot 5                               */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    address[] public synts;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Constructor                          */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    constructor(bytes memory settingsData) {
        (COLLATERAL, IPX, treasury, CASA_DE_PAPEL, ORACLE, maxLTV) = abi.decode(
            settingsData,
            (address, address, address, ICasaDePapel, IPriceOracle, uint256)
        );

        COLLATERAL_DECIMALS_FACTOR = 10**IERC20Metadata(COLLATERAL).decimals();
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Modifier                             */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    modifier isSolvent() {
        _;
        if (!_isSolvent()) revert SyntheticMarket__InsolventCaller();
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       External                             */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    function deposit(address to, uint256 amount) external {
        _deposit(to, amount);
    }

    function withdraw(address to, uint256 amount) external isSolvent {
        _withdraw(to, amount);
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Private                              */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    function _deposit(address to, uint256 amount) private {
        COLLATERAL.safeTransferFrom(msg.sender, address(this), amount);

        accountCollateralOf[to].collateral += uint224(amount);

        emit Deposit(msg.sender, to, amount);
    }

    function _withdraw(address to, uint256 amount) private {
        accountCollateralOf[msg.sender].collateral -= uint224(amount);

        COLLATERAL.safeTransfer(to, amount);

        emit Withdraw(msg.sender, to, amount);
    }

    function _mint(
        address synt,
        address to,
        uint256 amount
    ) private {
        SyntInfo memory syntInfo = syntInfoOf[synt];

        // Revert if this is not a synthetic token created by this contract.
        if (!syntInfo.whitelisted) revert SyntheticMarket__InvalidSynt();

        AccountSynt memory userAccount = accountSyntOf[msg.sender][synt];

        // Update the IPX and Synthetic rewards before any state changes.
        if (syntInfo.totalSynt != 0)
            (syntInfo, userAccount) = _preRewardsUpdate(
                synt,
                syntInfo,
                userAccount
            );

        // Update the synt amount state.
        unchecked {
            syntInfo.totalSynt += uint224(amount);
            userAccount.synt += amount;
        }

        // We update the state to avoid double counting the rewards.
        (syntInfoOf[synt], accountSyntOf[msg.sender][synt]) = _postRewardUpdate(
            syntInfo,
            userAccount
        );

        // Tell this contract that the user has minted `synt`, so it needs be part of the solvency check.
        accountCollateralOf[msg.sender].syntsIn = _addSynt(
            accountCollateralOf[msg.sender].syntsIn,
            syntInfo.offset
        );

        // Give creator benefits to the `msg.sender` for `synt`.
        _addCreator(synt, msg.sender, userAccount.synt);

        // Mint the `synt` to the `to` address.
        ERC20Fees(synt).mint(to, amount);
        // Mint an equal amount of a receipt token to receive IPX rewards.
        ERC20Receipt(syntInfo.receipt).mint(amount);

        // Deposit the receipt tokens in the master chef.
        CASA_DE_PAPEL.stake(syntInfo.poolId, amount);
        // Restake any IPX in this contract.
        CASA_DE_PAPEL.stake(0, _getIPXBalance());

        emit Mint(synt, msg.sender, to, amount);
    }

    function _preRewardsUpdate(
        address synt,
        SyntInfo memory syntInfo,
        AccountSynt memory userAccount
    ) private returns (SyntInfo memory, AccountSynt memory) {
        // calculate synt rewards
        syntInfo.totalSyntRewardsPerToken += ERC20Fees(synt).claimFees().fdiv(
            syntInfo.totalSynt
        );

        // calculate IPX rewards
        syntInfo.totalIPXRewardsPerToken += (_harvestFarm(syntInfo.poolId) +
            _stakeIPX()).fdiv(syntInfo.totalSynt);

        unchecked {
            userAccount.syntRewards += syntInfo
                .totalSyntRewardsPerToken
                .fmul(userAccount.synt)
                .toUint128();

            userAccount.ipxRewards += syntInfo
                .totalIPXRewardsPerToken
                .fmul(userAccount.synt)
                .toUint128();
        }

        return (syntInfo, userAccount);
    }

    function _postRewardUpdate(
        SyntInfo memory syntInfo,
        AccountSynt memory userAccount
    ) private pure returns (SyntInfo memory, AccountSynt memory) {
        userAccount.ipxRewardDebt = syntInfo.totalIPXRewardsPerToken.fmul(
            userAccount.synt
        );
        userAccount.syntRewardDebt = syntInfo.totalSyntRewardsPerToken.fmul(
            userAccount.synt
        );

        return (syntInfo, userAccount);
    }

    function _getIPXBalance() internal view returns (uint256) {
        return IERC20(IPX).balanceOf(address(this));
    }

    function _safeIPXTransfer(address to, uint256 amount) internal {
        IPX.safeTransfer(to, _getIPXBalance().min(amount));
    }

    function _stakeIPX() internal returns (uint256) {
        CASA_DE_PAPEL.stake(0, _getIPXBalance());
        // The current {balanceOf} IPX is equivalent to all rewards because we just staked our entire {IPX} balance.
        return _getIPXBalance();
    }

    function _harvestIPX() internal returns (uint256 ipxHarvested) {
        ipxHarvested = _getIPXBalance();

        CASA_DE_PAPEL.unstake(0, 0);
        // Need to subtract the previous balance and the withdrawn amount from the current {balanceOf} to know many {IPX} rewards  we got.
        ipxHarvested = _getIPXBalance() - ipxHarvested;
    }

    function _withdrawFarm(uint256 poolId, uint256 amount)
        internal
        returns (uint256 ipxHarvested)
    {
        // Save the current {IPX} balance before calling the withdraw function because it will give us rewards.
        ipxHarvested = _getIPXBalance();
        CASA_DE_PAPEL.unstake(poolId, amount);
        // The difference between the previous {IPX} balance and the current balance is the rewards obtained via the withdraw function.
        ipxHarvested = _getIPXBalance() - ipxHarvested;
    }

    function _harvestFarm(uint256 poolId)
        internal
        returns (uint256 ipxHarvested)
    {
        // Need to save the {balanceOf} {IPX} before the deposit function to calculate the rewards.
        ipxHarvested = _getIPXBalance();
        CASA_DE_PAPEL.stake(poolId, 0);
        // Find how much IPX we earned after depositing as the deposit functions always {transfer} the pending {IPX} rewards.
        ipxHarvested = _getIPXBalance() - ipxHarvested;
    }

    function _addCreator(
        address synt,
        address user,
        uint256 syntBalance
    ) private {
        if (!ERC20Fees(synt).isCreator(user) && syntBalance != 0)
            ERC20Fees(synt).addCreator(user);
    }

    function _removeCreator(
        address synt,
        address user,
        uint256 syntBalance
    ) private {
        if (ERC20Fees(synt).isCreator(user) && syntBalance == 0)
            ERC20Fees(synt).removeCreator(user);
    }

    function _safeTransferSynt(
        address synt,
        address to,
        uint256 amount
    ) private {
        address(synt).safeTransfer(
            to,
            amount.min(ERC20Fees(synt).balanceOf(address(this)))
        );
    }

    function _isSolvent() private view returns (bool) {
        AccountCollateral memory collateralAccount = accountCollateralOf[
            msg.sender
        ];

        uint256 totalUSDOwed;

        // synts length is capped at 30.
        for (uint8 i; i < synts.length; ) {
            // If the user does not hold the synt at index i, he has no debt in that synt.
            if (!_hasSynt(collateralAccount.syntsIn, i)) continue;

            address synt = synts[i];

            AccountSynt memory account = accountSyntOf[synt][msg.sender];

            uint256 usdOwed = ORACLE.getTokenUSDPrice(synt, account.synt);

            if (usdOwed == 0) revert SyntheticMarket__InvalidDebtCalculation();

            totalUSDOwed += usdOwed;

            unchecked {
                i++;
            }
        }

        if (totalUSDOwed == 0) return true;

        uint256 collateral = COLLATERAL_DECIMALS_FACTOR == 1 ether
            ? collateralAccount.collateral
            : uint256(collateralAccount.collateral).mulDiv(
                1 ether,
                COLLATERAL_DECIMALS_FACTOR
            );

        return collateral.fmul(maxLTV) >= totalUSDOwed;
    }

    function _hasSynt(uint32 syntIn, uint8 assetOffset)
        private
        pure
        returns (bool)
    {
        return (syntIn & (uint32(1) << assetOffset) != 0);
    }

    function _addSynt(uint32 syntIn, uint8 assetOffset)
        private
        pure
        returns (uint32)
    {
        return syntIn | (uint32(1) << assetOffset);
    }

    function _removeSynt(uint32 syntIn, uint8 assetOffset)
        private
        pure
        returns (uint32)
    {
        return syntIn & ~(uint32(1) << assetOffset);
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Owner only                           */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    function addSynt(uint256 poolId, bytes calldata erc20Data)
        external
        onlyOwner
    {
        (string memory name, string memory symbol, uint256 transferFee) = abi
            .decode(erc20Data, (string, string, uint256));

        address synt = address(new ERC20Fees(name, symbol, transferFee));

        address syntReceipt = address(
            new ERC20Receipt(
                string.concat(name, " Receipt"),
                string.concat(symbol, "R")
            )
        );

        syntReceipt.safeApprove(address(CASA_DE_PAPEL), type(uint256).max);

        syntInfoOf[synt] = SyntInfo(
            uint8(synts.length),
            true,
            0,
            poolId.toUint96(),
            syntReceipt,
            0,
            0
        );

        synts.push(synt);

        unchecked {
            if (synts.length > MAX_SYNT)
                revert SyntheticMarket__MaxNumberOfSyntsReached();
        }

        emit SyntAdded(synt, syntReceipt);
    }

    function updateTreasury(address _treasury) external onlyOwner {
        emit TreasuryUpdated(treasury, _treasury);

        treasury = _treasury;
    }

    function updateTransferFee(address synt, uint256 transferFee)
        external
        onlyOwner
    {
        // Maximum transferFee for any synt token is 1%.
        if (transferFee >= 0.01 ether)
            revert SyntheticMarket__InvalidTransferFee();

        ERC20Fees(synt).setTransferFee(transferFee);
    }
}
