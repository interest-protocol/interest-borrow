// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";

import "@interest-protocol/library/MathLib.sol";
import "@interest-protocol/library/SafeCastLib.sol";
import "@interest-protocol/library/SafeTransferErrors.sol";
import "@interest-protocol/library/SafeTransferLib.sol";

import "../interfaces/IPriceOracle.sol";
import "../interfaces/ISwap.sol";

import "./ERC20Fees.sol";

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
        uint256 rewardDebt;
    }

    struct SyntInfo {
        uint8 offset;
        bool whitelisted;
        uint240 totalSynt;
        uint256 totalRewardsPerToken;
    }

    struct LiquidationInfo {
        uint256 allCollateral;
        uint256 allSYNT;
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Events                               */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    event SyntAdded(address indexed synt);

    event TreasuryUpdated(
        address indexed oldTreasury,
        address indexed newTreasury
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

    uint256 private COLLATERAL_DECIMALS_FACTOR;

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
        (COLLATERAL, treasury, ORACLE, maxLTV) = abi.decode(
            settingsData,
            (address, address, IPriceOracle, uint256)
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

    function swap(
        address synt0,
        address synt1,
        uint256 amount
    ) external isSolvent {
        // Retrieve the information about each synt
        SyntInfo memory info0 = syntInfoOf[synt0];
        SyntInfo memory info1 = syntInfoOf[synt1];

        // We check if the assets are synthetics managed by this contract.
        if (!info0.whitelisted || !info1.whitelisted)
            revert SyntheticMarket__InvalidSynt();

        // Retrieve caller's synt0 account;
        AccountSynt memory callerSynt0Account = accountSyntOf[synt0][
            msg.sender
        ];
        // Retrieve caller's synt1 account;
        AccountSynt memory callerSynt1Account = accountSyntOf[synt1][
            msg.sender
        ];
        // Retrieve caller's collateral account;
        AccountCollateral memory callerCollateralAccount = accountCollateralOf[
            msg.sender
        ];

        // Update the synt0 rewards;
        // If  info0.totalSynt is 0, it should throw to revert the whole transaction.
        info0.totalRewardsPerToken += ERC20Fees(synt0).claimFees().fdiv(
            info0.totalSynt
        );

        // Send the synt0 rewards to the caller.
        _safeTransferSynt(
            synt0,
            msg.sender,
            info0.totalRewardsPerToken.fmul(callerSynt0Account.synt) -
                callerSynt0Account.rewardDebt
        );

        // Burn the synt0 from the caller's address
        ERC20Fees(synt0).burn(msg.sender, amount);

        // Reduce the caller's synt0 balance
        callerSynt0Account.synt -= amount;

        // Decreased the total amount of synt0 created by this contract.
        unchecked {
            info0.totalSynt -= uint240(amount);
        }

        // Update the caller's synt0 reward debt. He is considered to have received all his/her rewards.
        callerSynt0Account.rewardDebt = info0.totalRewardsPerToken.fmul(
            callerSynt0Account.synt
        );

        // If the caller synt0 balance is zero, we need to remove is from syntsIn.
        if (callerSynt0Account.synt == 0)
            callerCollateralAccount.syntsIn = _removeSynt(
                callerCollateralAccount.syntsIn,
                info0.offset
            );

        {
            // Retrieve the transferFee from synt0;
            uint256 synt0TransferFee = ERC20Fees(synt0).transferFee();

            // Calculate the amount of synt0 that the treasury will receive.
            uint256 treasuryAmount = amount.fmul(synt0TransferFee);

            // Mint the treasury tokens.
            ERC20Fees(synt0).mint(treasury, treasuryAmount);

            // Get total value of USD of synt0 burned minus the treasury amount.
            uint256 totalUSDValueOfSynt0Burned = ORACLE.getTokenUSDPrice(
                synt0,
                amount - treasuryAmount
            );

            // Get the price of 1 token of synt1 in USD.
            uint256 usdValueOfOneSynt1 = ORACLE.getTokenUSDPrice(
                synt1,
                1 ether
            );

            // Divide the total value burned by the value of one token to calculate how much synt1 the user will receive.
            uint256 synt1Amount = totalUSDValueOfSynt0Burned.fdiv(
                usdValueOfOneSynt1
            );

            // Update the synt1 rewards.
            info1.totalRewardsPerToken += ERC20Fees(synt1).claimFees().fdiv(
                info1.totalSynt
            );

            // Send the synt1 rewards to the caller if he has any synt1.
            if (callerSynt1Account.synt != 0)
                _safeTransferSynt(
                    synt1,
                    msg.sender,
                    info1.totalRewardsPerToken.fmul(callerSynt1Account.synt) -
                        callerSynt1Account.rewardDebt
                );

            // Update the user synt1 balance.
            unchecked {
                callerSynt1Account.synt += synt1Amount;
            }

            // Update the caller's synt1 reward debt. He is considered to have received all his/her rewards.
            callerSynt1Account.rewardDebt = callerSynt1Account.synt.fmul(
                info1.totalRewardsPerToken
            );

            // Update the amount of synt1 minted by this contract.
            info1.totalSynt += uint240(synt1Amount);

            // Mint syn1 to the caller.
            ERC20Fees(synt1).mint(msg.sender, synt1Amount);

            // Add synt1 to the syntsIn to the caller's collateral account.
            callerCollateralAccount.syntsIn = _addSynt(
                callerCollateralAccount.syntsIn,
                info1.offset
            );
        }

        // Update the global state.
        syntInfoOf[synt0] = info0;
        syntInfoOf[synt1] = info1;
        accountCollateralOf[msg.sender] = callerCollateralAccount;
        accountSyntOf[synt0][msg.sender] = callerSynt0Account;
        accountSyntOf[synt1][msg.sender] = callerSynt1Account;
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       private                             */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

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

    function addSynt(bytes calldata erc20Data) external onlyOwner {
        (string memory name, string memory symbol, uint256 transferFee) = abi
            .decode(erc20Data, (string, string, uint256));

        address synt = address(new ERC20Fees(name, symbol, transferFee));

        syntInfoOf[synt] = SyntInfo(uint8(synts.length), true, 0, 0);

        synts.push(synt);

        unchecked {
            if (synts.length > MAX_SYNT)
                revert SyntheticMarket__MaxNumberOfSyntsReached();
        }

        emit SyntAdded(synt);
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
