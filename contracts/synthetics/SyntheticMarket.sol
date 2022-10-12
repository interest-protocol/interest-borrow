// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import "@interest-protocol/library/MathLib.sol";
import "@interest-protocol/library/SafeCastLib.sol";
import "@interest-protocol/library/SafeTransferErrors.sol";
import "@interest-protocol/library/SafeTransferLib.sol";

import "../interfaces/IPriceOracle.sol";
import "../interfaces/ISwap.sol";

import "./ERC20Fees.sol";

contract SyntheticMarket is
    Initializable,
    SafeTransferErrors,
    OwnableUpgradeable,
    UUPSUpgradeable
{
    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Libs                                 */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    using SafeTransferLib for address;
    using MathLib for uint256;
    using SafeCastLib for uint256;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Events                               */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    event LiquidationFeeUpdated(uint256 oldFee, uint256 newFee);

    event MaxLTVRatioUpdated(uint256 oldFee, uint256 newFee);

    event Deposit(address indexed from, address indexed to, uint256 amount);

    event Withdraw(address indexed from, address indexed to, uint256 amount);

    event GetRewards(address indexed to, uint256 amount);

    event Mint(
        address indexed from,
        address indexed to,
        uint256 amount,
        uint256 rewards
    );

    event Burn(
        address indexed from,
        address indexed to,
        uint256 amount,
        uint256 rewards
    );

    event Liquidate(
        address indexed liquidator,
        address indexed debtor,
        uint256 rwa,
        uint256 collateral
    );

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Error                                */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    error SyntheticMarket__InvalidFee();

    error SyntheticMarket__InvalidExchangeRate();

    error SyntheticMarket__InsolventCaller();

    error SyntheticMarket__InvalidRequest();

    error SyntheticMarket__InvalidLiquidationAmount();

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Structs                              */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    struct Account {
        uint128 collateral;
        uint128 synt;
        uint256 rewardDebt;
    }

    struct LiquidationInfo {
        uint256 allCollateral;
        uint256 allSYNT;
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       No Slot                              */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    uint256 internal constant DEPOSIT_REQUEST = 0;

    uint256 internal constant WITHDRAW_REQUEST = 1;

    uint256 internal constant MINT_REQUEST = 2;

    uint256 internal constant BURN_REQUEST = 3;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Slot 0                               */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    ERC20Fees public SYNT;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Slot 1                               */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    address private COLLATERAL;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Slot 2                               */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    IPriceOracle internal ORACLE;

    uint96 public liquidationFee;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Slot 3                               */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    uint128 public maxLTVRatio;

    uint128 public totalSynt;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Slot 4                               */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    uint256 public totalRewardsPerToken;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Slot 5                               */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    mapping(address => Account) public accountOf;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Initializer                          */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    function initialize(bytes calldata erc20Data, bytes calldata settingsData)
        external
        initializer
    {
        // Set the owner
        __Ownable_init();

        (
            string memory name,
            string memory symbol,
            address treasury,
            uint256 transferFee
        ) = abi.decode(erc20Data, (string, string, address, uint256));

        (COLLATERAL, ORACLE, maxLTVRatio, liquidationFee) = abi.decode(
            settingsData,
            (address, IPriceOracle, uint128, uint96)
        );

        SYNT = new ERC20Fees(name, symbol, treasury, transferFee);
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Modifier                             */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    modifier isSolvent() {
        _;
        if (
            !_isSolvent(
                msg.sender,
                ORACLE.getTokenUSDPrice(address(SYNT), 1 ether)
            )
        ) revert SyntheticMarket__InsolventCaller();
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       External Functions                   */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    function getPendingRewards(address account)
        external
        view
        returns (uint256)
    {
        Account memory user = accountOf[account];

        if (user.synt == 0) return 0;

        uint256 pendingRewardsPerToken = SYNT
            .deployerBalance()
            .fmul(0.9e18)
            .fdiv(totalSynt) + totalRewardsPerToken;

        return
            uint256(user.synt).fmul(pendingRewardsPerToken) - user.rewardDebt;
    }

    function deposit(address to, uint256 amount) external {
        _deposit(to, amount);
    }

    function withdraw(address to, uint256 amount) external isSolvent {
        _withdraw(to, amount);
    }

    function mint(address to, uint256 amount) external isSolvent {
        _mint(to, amount);
    }

    function burn(address account, uint256 amount) external {
        _burn(account, amount);
    }

    function getRewards() external {
        // Save storage state in memory to save gas.
        Account memory user = accountOf[msg.sender];

        if (user.synt == 0) return;

        // Save storage state in memory to save gas.
        uint256 _totalRewardsPerToken = totalRewardsPerToken;

        uint256 feesClaimed = SYNT.claimFees();

        if (feesClaimed == 0) return;

        _totalRewardsPerToken += feesClaimed.fdiv(totalSynt);

        uint256 rewards = _totalRewardsPerToken.fmul(user.synt) -
            user.rewardDebt;

        user.rewardDebt = _totalRewardsPerToken.fmul(user.synt);

        // Update Global state
        accountOf[msg.sender] = user;
        totalRewardsPerToken = _totalRewardsPerToken;

        if (rewards != 0) _safeTransferRWA(msg.sender, rewards);

        emit GetRewards(msg.sender, rewards);
    }

    function request(uint256[] calldata requests, bytes[] calldata requestArgs)
        external
    {
        // Indicates if the user must be solvent after the actions.
        // We only want to call {_isSolvent} once to save gas.
        bool checkForSolvency;

        for (uint256 i; i < requests.length; i = i.uAdd(1)) {
            uint256 requestAction = requests[i];

            if (_checkForSolvency(requestAction) && !checkForSolvency)
                checkForSolvency = true;

            _request(requestAction, requestArgs[i]);
        }

        if (checkForSolvency)
            if (
                !_isSolvent(
                    msg.sender,
                    ORACLE.getTokenUSDPrice(address(SYNT), 1 ether)
                )
            ) revert SyntheticMarket__InsolventCaller();
    }

    function liquidate(
        address[] calldata accounts,
        uint256[] calldata RWAs,
        address recipient,
        bytes calldata data
    ) external {
        uint256 exchangeRate = ORACLE.getTokenUSDPrice(
            address(COLLATERAL),
            1 ether
        );

        LiquidationInfo memory liquidationInfo;

        uint256 _totalRewardsPerToken = totalRewardsPerToken;

        _totalRewardsPerToken += SYNT.claimFees().fdiv(totalSynt);

        totalRewardsPerToken = _totalRewardsPerToken;

        // Loop through all positions
        for (uint256 i; i < accounts.length; i = i.uAdd(1)) {
            address account = accounts[i];

            // If the user has enough collateral to cover his debt. He cannot be liquidated. Move to the next one.
            if (_isSolvent(account, exchangeRate)) continue;

            Account memory user = accountOf[account];

            uint256 amountToLiquidate = RWAs[i].min(user.synt);

            uint256 rewards = _totalRewardsPerToken.fmul(user.synt) -
                user.rewardDebt;

            unchecked {
                user.synt -= amountToLiquidate.toUint128();
            }

            uint256 collateralToCover = amountToLiquidate.fmul(exchangeRate);

            unchecked {
                // Calculate the collateralFee (for the liquidator and the protocol)
                collateralToCover += collateralToCover.fmul(liquidationFee);
            }

            user.collateral -= collateralToCover.toUint128();
            user.rewardDebt = _totalRewardsPerToken.fmul(user.synt);

            // Update Global state
            accountOf[account] = user;

            liquidationInfo.allCollateral += collateralToCover;
            liquidationInfo.allSYNT += amountToLiquidate;

            if (rewards != 0) _safeTransferRWA(account, rewards);

            emit Liquidate(
                msg.sender,
                account,
                amountToLiquidate,
                collateralToCover
            );
        }

        if (liquidationInfo.allSYNT == 0)
            revert SyntheticMarket__InvalidLiquidationAmount();

        totalSynt -= liquidationInfo.allSYNT.toUint128();

        COLLATERAL.safeTransfer(recipient, liquidationInfo.allCollateral);

        // If the {msg.sender} calls this function with data, we assume the recipint is a contract that implements the {sellOneToken} from the ISwap interface.
        if (data.length != 0)
            ISwap(recipient).sellOneToken(
                data,
                address(COLLATERAL),
                liquidationInfo.allCollateral,
                liquidationInfo.allSYNT
            );

        SYNT.burn(msg.sender, liquidationInfo.allSYNT);
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Core Logic                           */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    function _deposit(address to, uint256 amount) internal {
        COLLATERAL.safeTransferFrom(msg.sender, address(this), amount);

        // Update Global state
        accountOf[to].collateral += amount.toUint128();

        emit Deposit(msg.sender, to, amount);
    }

    function _withdraw(address to, uint256 amount) internal {
        accountOf[msg.sender].collateral -= amount.toUint128();

        COLLATERAL.safeTransfer(to, amount);

        emit Withdraw(msg.sender, to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        // Save storage state in memory to save gas.
        Account memory user = accountOf[msg.sender];

        uint256 _totalSynt = totalSynt;
        uint256 _totalRewardsPerToken = totalRewardsPerToken;

        uint256 rewards;

        if (user.synt != 0) {
            _totalRewardsPerToken += SYNT.claimFees().fdiv(_totalSynt);

            unchecked {
                rewards +=
                    _totalRewardsPerToken.fmul(user.synt) -
                    user.rewardDebt;
            }
        }

        // Update local State
        user.synt += amount.toUint128();

        unchecked {
            _totalSynt += amount;
        }
        user.rewardDebt = _totalRewardsPerToken.fmul(user.synt);

        // Update Global state
        accountOf[msg.sender] = user;
        totalSynt = _totalSynt.toUint128();
        totalRewardsPerToken = _totalRewardsPerToken;

        SYNT.mint(to, amount);
        if (rewards != 0) _safeTransferRWA(to, rewards);
    }

    function _burn(address account, uint256 amount) internal {
        // Save storage state in memory to save gas.
        Account memory user = accountOf[account];

        uint256 _totalSynt = totalSynt;
        uint256 _totalRewardsPerToken = totalRewardsPerToken;

        _totalRewardsPerToken += SYNT.claimFees().fdiv(_totalSynt);

        uint256 rewards;

        unchecked {
            rewards += _totalRewardsPerToken.fmul(user.synt) - user.rewardDebt;
        }

        // We want to burn before updating the state
        SYNT.burn(msg.sender, amount);

        user.synt -= amount.toUint128();

        unchecked {
            _totalSynt -= amount;
        }

        user.rewardDebt = _totalRewardsPerToken.fmul(user.synt);

        // Update Global state
        accountOf[account] = user;
        totalSynt = _totalSynt.toUint128();
        totalRewardsPerToken = _totalRewardsPerToken;

        if (rewards != 0) _safeTransferRWA(account, rewards);
    }

    function _safeTransferRWA(address to, uint256 amount) internal {
        address(SYNT).safeTransfer(
            to,
            amount.min(SYNT.balanceOf(address(this)))
        );
    }

    function _isSolvent(address account, uint256 exchangeRate)
        internal
        view
        returns (bool)
    {
        if (exchangeRate == 0) revert SyntheticMarket__InvalidExchangeRate();

        // How much the user has borrowed.
        Account memory user = accountOf[account];

        // Account has no open loans. So he is solvent.
        if (user.synt == 0) return true;

        // Account has no collateral so he can not open any loans. He is insolvent.
        if (user.collateral == 0) return false;

        // All collateral is in stable coin so we assume it is always 1 dollar.
        // Collateral in USD * {maxLTVRatio} has to be greater than principal + interest rate accrued in DINERO which is pegged to USD
        return
            uint256(user.collateral).fmul(maxLTVRatio) >=
            uint256(user.synt).fmul(exchangeRate);
    }

    function _checkForSolvency(uint256 req) internal pure returns (bool pred) {
        if (req == WITHDRAW_REQUEST || req == MINT_REQUEST) pred = true;
    }

    function _request(uint256 requestAction, bytes calldata data) internal {
        (address to, uint256 amount) = abi.decode(data, (address, uint256));

        if (requestAction == DEPOSIT_REQUEST) {
            return _deposit(to, amount);
        }

        if (requestAction == WITHDRAW_REQUEST) {
            return _withdraw(to, amount);
        }

        if (requestAction == MINT_REQUEST) {
            return _mint(to, amount);
        }

        if (requestAction == BURN_REQUEST) {
            return _burn(to, amount);
        }

        revert SyntheticMarket__InvalidRequest();
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Owner Logic                          */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    function setTransferFee(uint256 transferFee) external onlyOwner {
        SYNT.setTransferFee(transferFee);
    }

    function setTreasury(address treasury) external onlyOwner {
        SYNT.setTreasury(treasury);
    }

    function setLiquidationFee(uint256 fee) external onlyOwner {
        if (fee > 0.2e18) revert SyntheticMarket__InvalidFee();
        emit LiquidationFeeUpdated(liquidationFee, fee);
        liquidationFee = fee.toUint96();
    }

    function setMaxLTVRatio(uint256 ratio) external onlyOwner {
        if (ratio > 0.9e18) revert SyntheticMarket__InvalidFee();
        emit MaxLTVRatioUpdated(maxLTVRatio, ratio);
        maxLTVRatio = ratio.toUint128();
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       UUPS Logic                           */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    function _authorizeUpgrade(address)
        internal
        view
        override
        onlyOwner
    //solhint-disable-next-line no-empty-blocks
    {

    }
}
