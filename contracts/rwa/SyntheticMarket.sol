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
        uint128 RWA;
        uint256 rewardDebt;
    }

    struct LiquidationInfo {
        uint256 allCollateral;
        uint256 allRWA;
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

    ERC20Fees public RWA;

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

    uint128 public totalRWA;

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

        RWA = new ERC20Fees(name, symbol, treasury, transferFee);
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Modifier                             */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    modifier isSolvent() {
        _;
        if (
            !_isSolvent(
                msg.sender,
                ORACLE.getTokenUSDPrice(address(RWA), 1 ether)
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
        if (totalRWA == 0) return 0;

        uint256 pendingRewardsPerToken = RWA
            .deployerBalance()
            .fmul(0.8e18)
            .fdiv(totalRWA) + totalRewardsPerToken;

        Account memory user = accountOf[account];

        return uint256(user.RWA).fmul(pendingRewardsPerToken) - user.rewardDebt;
    }

    function deposit(address to, uint256 amount) external {
        _deposit(to, amount);
    }

    function withdraw(address to, uint256 amount) external isSolvent {
        _withdraw(msg.sender, amount);

        COLLATERAL.safeTransfer(to, amount);

        emit Withdraw(msg.sender, to, amount);
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

        if (user.RWA == 0) return;

        // Save storage state in memory to save gas.
        uint256 _totalRewardsPerToken = totalRewardsPerToken;

        _totalRewardsPerToken += RWA.claimFees().fdiv(totalRWA);

        uint256 rewards = _totalRewardsPerToken.fmul(user.RWA) -
            user.rewardDebt;

        user.rewardDebt = _totalRewardsPerToken.fmul(user.RWA);

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
                    ORACLE.getIPXLPTokenUSDPrice(address(COLLATERAL), 1 ether)
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

        _totalRewardsPerToken += RWA.claimFees().fdiv(totalRWA);

        totalRewardsPerToken = _totalRewardsPerToken;

        // Loop through all positions
        for (uint256 i; i < accounts.length; i = i.uAdd(1)) {
            address account = accounts[i];

            // If the user has enough collateral to cover his debt. He cannot be liquidated. Move to the next one.
            if (_isSolvent(account, exchangeRate)) continue;

            Account memory user = accountOf[account];

            // Liquidator cannot repay more than the what `account` borrowed.
            // Note the liquidator does not need to close the full position.
            uint256 amountToLiquidate = RWAs[i].min(user.RWA);

            uint256 rewards = (_totalRewardsPerToken.fmul(user.RWA) -
                user.rewardDebt).toUint128();

            unchecked {
                // The minimum value is it's own value. So this can never underflow.
                // Update the userLoan global state
                user.RWA -= amountToLiquidate.toUint128();
            }

            uint256 collateralToCover = amountToLiquidate.fmul(exchangeRate);

            unchecked {
                // Calculate the collateralFee (for the liquidator and the protocol)
                collateralToCover += collateralToCover.fmul(liquidationFee);
            }

            user.collateral -= collateralToCover.toUint128();
            user.rewardDebt = _totalRewardsPerToken.fmul(user.RWA);

            // Update Global state
            accountOf[account] = user;

            liquidationInfo.allCollateral += collateralToCover;
            liquidationInfo.allRWA += amountToLiquidate;

            if (rewards != 0) _safeTransferRWA(account, rewards);

            emit Liquidate(
                msg.sender,
                account,
                amountToLiquidate,
                collateralToCover
            );
        }

        if (liquidationInfo.allRWA == 0)
            revert SyntheticMarket__InvalidLiquidationAmount();

        totalRWA -= liquidationInfo.allRWA.toUint128();

        COLLATERAL.safeTransfer(recipient, liquidationInfo.allCollateral);

        // If the {msg.sender} calls this function with data, we assume the recipint is a contract that implements the {sellOneToken} from the ISwap interface.
        if (data.length != 0)
            ISwap(recipient).sellOneToken(
                data,
                address(COLLATERAL),
                liquidationInfo.allCollateral,
                liquidationInfo.allRWA
            );

        RWA.burn(msg.sender, liquidationInfo.allRWA);
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Core Logic                           */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    function _deposit(address to, uint256 amount) internal {
        // Save storage state in memory to save gas.
        Account memory user = accountOf[to];

        COLLATERAL.safeTransferFrom(msg.sender, address(this), amount);

        unchecked {
            user.collateral += amount.toUint128();
        }

        // Update Global state
        accountOf[to] = user;

        emit Deposit(msg.sender, to, amount);
    }

    function _withdraw(address from, uint256 amount) internal {
        accountOf[from].collateral -= amount.toUint128();
    }

    function _mint(address to, uint256 amount) internal {
        // Save storage state in memory to save gas.
        Account memory user = accountOf[msg.sender];

        uint256 _totalRWA = totalRWA;
        uint256 _totalRewardsPerToken = totalRewardsPerToken;

        uint256 rewards;

        if (user.RWA != 0) {
            _totalRewardsPerToken += RWA.claimFees().fdiv(_totalRWA);

            unchecked {
                // Calculate and add how many rewards the user accrued.
                rewards += (_totalRewardsPerToken.fmul(user.RWA) -
                    user.rewardDebt).toUint128();
            }
        }

        // Update local State
        user.RWA += amount.toUint128();

        unchecked {
            _totalRWA += amount;
        }
        user.rewardDebt = _totalRewardsPerToken.fmul(user.RWA);

        // Update Global state
        accountOf[msg.sender] = user;
        totalRWA = _totalRWA.toUint128();
        totalRewardsPerToken = _totalRewardsPerToken;

        RWA.mint(to, amount);
        if (rewards != 0) _safeTransferRWA(to, rewards);
    }

    function _burn(address account, uint256 amount) internal {
        // Save storage state in memory to save gas.
        Account memory user = accountOf[account];

        uint256 _totalRWA = totalRWA;
        uint256 _totalRewardsPerToken = totalRewardsPerToken;

        _totalRewardsPerToken += RWA.claimFees().fdiv(_totalRWA);

        uint256 rewards;

        unchecked {
            // We do not need to calculate rewards if the user has no open deposits in this contract.

            // Calculate and add how many rewards the user accrued.
            rewards += (_totalRewardsPerToken.fmul(user.RWA) - user.rewardDebt)
                .toUint128();
        }

        // We want to burn before updating the state
        RWA.burn(msg.sender, amount);

        user.RWA -= amount.toUint128();

        unchecked {
            _totalRWA -= amount;
        }

        user.rewardDebt = _totalRewardsPerToken.fmul(user.RWA);

        // Update Global state
        accountOf[account] = user;
        totalRWA = _totalRWA.toUint128();
        totalRewardsPerToken = _totalRewardsPerToken;

        if (rewards != 0) _safeTransferRWA(account, rewards);
    }

    function _safeTransferRWA(address to, uint256 amount) internal {
        address(RWA).safeTransfer(to, amount.min(RWA.balanceOf(address(this))));
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
        if (user.RWA == 0) return true;

        // Account has no collateral so he can not open any loans. He is insolvent.
        if (user.collateral == 0) return false;

        // All collateral is in stable coin so we assume it is always 1 dollar.
        // Collateral in USD * {maxLTVRatio} has to be greater than principal + interest rate accrued in DINERO which is pegged to USD
        return
            uint256(user.collateral).fmul(maxLTVRatio) >=
            uint256(user.RWA).fmul(exchangeRate);
    }

    function _checkForSolvency(uint256 req) internal pure returns (bool pred) {
        if (req == WITHDRAW_REQUEST || req == MINT_REQUEST) pred = true;
    }

    function _request(uint256 requestAction, bytes calldata data) internal {
        if (requestAction == DEPOSIT_REQUEST) {
            (address to, uint256 amount) = abi.decode(data, (address, uint256));
            return _deposit(to, amount);
        }

        if (requestAction == WITHDRAW_REQUEST) {
            (address to, uint256 amount) = abi.decode(data, (address, uint256));
            _withdraw(msg.sender, amount);

            COLLATERAL.safeTransfer(to, amount);

            emit Withdraw(msg.sender, to, amount);

            return;
        }

        if (requestAction == MINT_REQUEST) {
            (address to, uint256 amount) = abi.decode(data, (address, uint256));
            return _mint(to, amount);
        }

        if (requestAction == BURN_REQUEST) {
            (address account, uint256 principal) = abi.decode(
                data,
                (address, uint256)
            );
            return _burn(account, principal);
        }

        revert SyntheticMarket__InvalidRequest();
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       Owner Logic                          */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    function setTransferFee(uint256 transferFee) external onlyOwner {
        RWA.setTransferFee(transferFee);
    }

    function setTreasury(address treasury) external onlyOwner {
        RWA.setTreasury(treasury);
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
