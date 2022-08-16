// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import "@interest-protocol/dex/interfaces/IPair.sol";
import "@interest-protocol/dex/interfaces/IRouter.sol";
import "@interest-protocol/tokens/interfaces/IDinero.sol";
import "@interest-protocol/earn/interfaces/ICasaDePapel.sol";
import "@interest-protocol/library/MathLib.sol";
import "@interest-protocol/library/SafeCastLib.sol";
import "@interest-protocol/library/SafeTransferErrors.sol";
import "@interest-protocol/library/SafeTransferLib.sol";

import "./interfaces/IPriceOracle.sol";
import "./interfaces/ISwap.sol";

contract LPFreeMarket is
    Initializable,
    SafeTransferErrors,
    OwnableUpgradeable,
    UUPSUpgradeable
{
    /*///////////////////////////////////////////////////////////////
                                  LIBS
    //////////////////////////////////////////////////////////////*/

    using SafeTransferLib for address;
    using MathLib for uint256;
    using SafeCastLib for uint256;

    /*///////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event Deposit(address indexed from, address indexed to, uint256 amount);

    event Withdraw(
        address indexed from,
        address indexed collateralRecipient,
        address indexed rewardsRecipient,
        uint256 amount
    );

    event Borrow(
        address indexed borrower,
        address indexed receiver,
        uint256 amount
    );

    event Repay(address indexed payer, address indexed payee, uint256 amount);

    event MaxTVLRatio(uint256);

    event LiquidationFee(uint256);

    event MaxBorrowAmount(uint256);

    event Compound(uint256 rewards, uint256 fee);

    event GetCollateralEarnings(address indexed treasury, uint256 amount);

    event NewTreasury(address indexed newTreasury);

    /*///////////////////////////////////////////////////////////////
                                  ERRORS
    //////////////////////////////////////////////////////////////*/

    error LPFreeMarket__InvalidMaxLTVRatio();

    error LPFreeMarket__InvalidLiquidationFee();

    error LPFreeMarket__MaxBorrowAmountReached();

    error LPFreeMarket__InvalidExchangeRate();

    error LPFreeMarket__InsolventCaller();

    error LPFreeMarket__InvalidAmount();

    error LPFreeMarket__InvalidAddress();

    error LPFreeMarket__InvalidWithdrawAmount();

    error LPFreeMarket__InvalidRequest();

    error LPFreeMarket__InvalidLiquidationAmount();

    error LPFreeMarket__Reentrancy();

    /*///////////////////////////////////////////////////////////////
                                  STRUCTS
    //////////////////////////////////////////////////////////////*/

    struct LiquidationInfo {
        uint256 allCollateral;
        uint256 allPrincipal;
        uint256 allFee;
    }

    struct Account {
        uint128 collateral;
        uint128 rewards;
        uint256 rewardDebt;
    }

    // NO MEMORY SLOT
    // Requests
    uint256 internal constant DEPOSIT_REQUEST = 0;

    uint256 internal constant WITHDRAW_REQUEST = 1;

    uint256 internal constant BORROW_REQUEST = 2;

    uint256 internal constant REPAY_REQUEST = 3;

    /*//////////////////////////////////////////////////////////////
                       STORAGE  SLOT 0                            */

    // Interest Swap Router address
    IRouter public ROUTER;
    //////////////////////////////////////////////////////////////

    /*//////////////////////////////////////////////////////////////
                       STORAGE  SLOT 1                            */

    // Dinero address
    IDinero public DNR;
    //////////////////////////////////////////////////////////////

    /*//////////////////////////////////////////////////////////////
                       STORAGE  SLOT 2                            */

    // Dinero address
    address public COLLATERAL;
    //////////////////////////////////////////////////////////////

    /*//////////////////////////////////////////////////////////////
                       STORAGE  SLOT 3                            */

    ICasaDePapel public CASA_DE_PAPEL;
    //////////////////////////////////////////////////////////////

    /*//////////////////////////////////////////////////////////////
                       STORAGE  SLOT 4                            */

    // Contract uses Chainlink to obtain the price in USD with 18 decimals
    IPriceOracle public ORACLE;

    // A fee that will be charged as a penalty of being liquidated.
    uint96 public liquidationFee;
    //////////////////////////////////////////////////////////////

    /*//////////////////////////////////////////////////////////////
                       STORAGE  SLOT 5                            */

    // Governance token for Interest Protocol
    address public IPX;

    // The current master chef farm being used.
    uint96 public POOL_ID;
    //////////////////////////////////////////////////////////////

    /*//////////////////////////////////////////////////////////////
                       STORAGE  SLOT 6                            */

    // principal + interest rate / collateral. If it is above this value, the user might get liquidated.
    uint128 public maxLTVRatio;

    // total amount of staking token in the contract
    uint128 public totalAmount;
    //////////////////////////////////////////////////////////////

    /*//////////////////////////////////////////////////////////////
                       STORAGE  SLOT 7                            */

    // Total amount of Dinero borrowed from this contract.
    uint128 public totalPrincipal;

    // Dinero Markets must have a max of how much DNR they can create to prevent liquidity issues during liquidations.
    uint128 public maxBorrowAmount;
    //////////////////////////////////////////////////////////////

    /*//////////////////////////////////////////////////////////////
                       STORAGE  SLOT 8                            */

    // Total amount of rewards per token ever collected by this contract
    uint256 public totalRewardsPerToken;
    //////////////////////////////////////////////////////////////

    /*//////////////////////////////////////////////////////////////
                       STORAGE  SLOT 9                            */

    // How much principal an address has borrowed.
    mapping(address => uint256) public userPrincipal;
    //////////////////////////////////////////////////////////////

    /*//////////////////////////////////////////////////////////////
                       STORAGE  SLOT 10                            */

    mapping(address => Account) public userAccount;

    //////////////////////////////////////////////////////////////

    /*//////////////////////////////////////////////////////////////
                       STORAGE  SLOT 11                            */

    uint256 public collateralEarnings;

    //////////////////////////////////////////////////////////////

    /*//////////////////////////////////////////////////////////////
                       STORAGE  SLOT 12                            */

    address public treasury;

    //////////////////////////////////////////////////////////////

    /*///////////////////////////////////////////////////////////////
                            INITIALIZER
    //////////////////////////////////////////////////////////////*/

    /**
     * Requirements:
     *
     * @param contracts addresses of contracts to intialize this market.
     * @param settings several global state uint variables to initialize this market
     *
     * - Can only be called at once and should be called during creation to prevent front running.
     */
    function initialize(bytes calldata contracts, bytes calldata settings)
        external
        initializer
    {
        __Ownable_init();

        _initializeContracts(contracts);

        _initializeSettings(settings);

        IPX.safeApprove(address(CASA_DE_PAPEL), type(uint256).max);
        COLLATERAL.safeApprove(address(CASA_DE_PAPEL), type(uint256).max);
        COLLATERAL.safeApprove(address(ROUTER), type(uint256).max);
    }

    function _initializeContracts(bytes memory data) private {
        (ROUTER, DNR, COLLATERAL, IPX, ORACLE, CASA_DE_PAPEL, treasury) = abi
            .decode(
                data,
                (
                    IRouter,
                    IDinero,
                    address,
                    address,
                    IPriceOracle,
                    ICasaDePapel,
                    address
                )
            );
    }

    function _initializeSettings(bytes memory data) private {
        (maxLTVRatio, liquidationFee, maxBorrowAmount, POOL_ID) = abi.decode(
            data,
            (uint128, uint96, uint128, uint96)
        );
    }

    /*///////////////////////////////////////////////////////////////
                            MODIFIERS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Check if a user loan is below the {maxLTVRatio}.
     * @dev We call the Chainlink oracle in this function, which can make this very costly on chains with a high gas price.
     */
    modifier isSolvent() {
        _;
        if (
            !_isSolvent(
                _msgSender(),
                ORACLE.getIPXLPTokenUSDPrice(
                    address(COLLATERAL),
                    // Oracle prices have 18 decimals.
                    1 ether
                )
            )
        ) revert LPFreeMarket__InsolventCaller();
    }

    /*///////////////////////////////////////////////////////////////
                        MUTATIVE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev This function collects the {COLLATERAL} earned from liquidations.
     */
    function getCollateralEarnings() external {
        uint256 earnings = collateralEarnings;

        if (earnings == 0) return;

        // Reset to 0
        collateralEarnings = 0;

        COLLATERAL.safeTransfer(treasury, earnings);

        emit GetCollateralEarnings(treasury, earnings);
    }

    /**
     * @dev This function compounds the {IPX} rewards in the pool id 0 and rewards the caller with 2% of the pending rewards.
     */
    function compound() external {
        // Variable to keep track of the {IPX} rewards we will get by depositing and unstaking.
        uint256 rewards;

        // Get rewards from the {COLLATERAL} pool.
        rewards = rewards.uAdd(_depositFarm(0));

        // Get rewards from the {IPX} pool.
        rewards = rewards.uAdd(_unstakeIPX(0));

        // Calculate the fee to reward the `msg.sender`.
        // The fee amounts to 2% of all the rewards harvested in this block.
        uint256 fee = rewards.fmul(0.02e18);

        rewards = rewards.uSub(fee);

        // Update the state
        totalRewardsPerToken += rewards.fdiv(totalAmount);

        // Pay the `msg.sender` the fee.
        _safeIPXTransfer(_msgSender(), fee);

        // Compound the remaining rewards in the {IPX} pool.
        // We already got the rewards up to this block. So the {IPX} pool rewards should be 0.
        // Therefore, we do not need to update the {_totalRewardsPerAmount} variable.
        CASA_DE_PAPEL.stake(0, _getIPXBalance());

        emit Compound(rewards, fee);
    }

    /**
     * @dev The tokens will be transfered from the {msg.sender}
     * @param to The address that the deposit will be assigned to.
     * @param amount The number of {COLLATERAL} tokens that will be deposited.
     */
    function deposit(address to, uint256 amount) external {
        _deposit(to, amount);
    }

    /**
     * @dev The tokens withdrawn will be from the {msg.sender} account.
     * @param to The address that will receive the tokens withdrawn.
     * @param amount The number of tokens to withdraw.
     */
    function withdraw(address to, uint256 amount) external isSolvent {
        _withdraw(_msgSender(), to, to, amount);
    }

    /**
     * @dev The borrow will be credited to the {msg.sender} account.
     * @param to The address that will receive the borrowed tokens.
     * @param amount How many dinero tokens the {msg.sender} is borrowing.
     */
    function borrow(address to, uint256 amount) external isSolvent {
        _borrow(to, amount);
    }

    /**
     * @dev The repayment is done by burning dinero from the {msg.sender} account.
     * @param account The account that will be credited with the repayment.
     * @param amount The number of Dinero tokens to repay.
     */
    function repay(address account, uint256 amount) external {
        _repay(account, amount);
    }

    /**
     * @notice This function allows to chain (deposit, withdraw, borrow and repay) operations in one call.
     * @param requests An array of uint actions to run.
     * @param requestArgs The arguments to call the action operations with.
     */
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
                    _msgSender(),
                    ORACLE.getIPXLPTokenUSDPrice(
                        address(COLLATERAL),
                        // Interest DEX LP tokens have 18 decimals
                        1 ether
                    )
                )
            ) revert LPFreeMarket__InsolventCaller();
    }

    /**
     * @notice This function closes underwater positions. It charges the borrower a fee and rewards the liquidator for keeping the integrity of the protocol. The liquidator can use the collateral to close the position or must have enough dinero to repay the loan.
     * @dev If the data field is not empty, the recipient is assumed to implement the interface {ISwap}.
     * @param accounts The  list of accounts to be liquidated.
     * @param principals The amount of principal the `msg.sender` wants to liquidate from each account.
     * @param recipient The address that will receive the proceeds gained by liquidating.
     * @param data arbitrary data to be passed to the recipient.
     *
     * Requirements:
     *
     * - He must hold enough Dinero to cover the sum of principals.
     */
    function liquidate(
        address[] calldata accounts,
        uint256[] calldata principals,
        address recipient,
        bytes calldata data
    ) external {
        // Liquidations must be based on the current exchange rate.
        uint256 _exchangeRate = ORACLE.getIPXLPTokenUSDPrice(
            address(COLLATERAL),
            // Interest DEX LP tokens have 18 decimals
            1 ether
        );

        // Save state to memory for gas saving

        LiquidationInfo memory liquidationInfo;

        // Loop through all positions
        for (uint256 i; i < accounts.length; i = i.uAdd(1)) {
            address account = accounts[i];

            // If the user has enough collateral to cover his debt. He cannot be liquidated. Move to the next one.
            if (_isSolvent(account, _exchangeRate)) continue;

            // How much principal the user has borrowed.
            uint256 loanPrincipal = userPrincipal[account];

            // Liquidator cannot repay more than the what `account` borrowed.
            // Note the liquidator does not need to close the full position.
            uint256 principal = principals[i].min(loanPrincipal);

            unchecked {
                // The minimum value is it's own value. So this can never underflow.
                // Update the userLoan global state
                userPrincipal[account] -= principal;
            }

            // How much collateral is needed to cover the loan.
            // Since Dinero is always 1 USD we can calculate this way.
            // We do not care what is the current price of Dinero as we want it to force to be 1 USD.
            uint256 collateralToCover = principal.fdiv(_exchangeRate);

            // Calculate the collateralFee (for the liquidator and the protocol)
            uint256 fee = collateralToCover.fmul(liquidationFee);

            // Remove the collateral from the account. We can consider the debt paid.
            // The rewards accrued will be sent to the liquidated `account`.
            _withdraw(account, address(this), account, collateralToCover + fee);

            emit Repay(_msgSender(), account, principal);

            liquidationInfo.allCollateral += collateralToCover;
            liquidationInfo.allPrincipal += principal;
            liquidationInfo.allFee += fee;
        }

        // There must have liquidations or we throw an error;
        // We throw an error instead of returning because we already changed state, sent events and withdrew tokens from collateral.
        // We need to revert all that.
        if (liquidationInfo.allPrincipal == 0)
            revert LPFreeMarket__InvalidLiquidationAmount();

        // We already substract these values from userAccount and userPrincipal mapping. So we d not need to check for underflow
        unchecked {
            // Update Global state
            totalPrincipal -= liquidationInfo.allPrincipal.toUint128();
        }

        // The protocol keeps 10% of the liquidation fee.
        uint256 protocolFee = liquidationInfo.allFee.fmul(0.1e18);

        unchecked {
            // Collect the protocol fee.
            collateralEarnings += protocolFee;
        }

        uint256 liquidatorAmount = liquidationInfo.allCollateral +
            liquidationInfo.allFee.uSub(protocolFee);

        // If any  data is passed, we assume the recipient is a swap contract.
        if (data.length > 0) {
            // Remove the liquidity to obtain token0 and token1 and send to the recipient.
            // Liquidator receives his reward in collateral.
            // Abstracted the logic to a function to avoid; Stack too deep compiler error.
            _sellCollateral(
                data,
                liquidatorAmount,
                liquidationInfo.allPrincipal,
                recipient
            );
        } else {
            // Send the collateral to the recipient without removing the liquidity.
            COLLATERAL.safeTransfer(recipient, liquidatorAmount);
        }

        // The {msg.sender} must have enough Dinero to be burned to cover all outstanding principal.
        DNR.burn(_msgSender(), liquidationInfo.allPrincipal);
    }

    /*///////////////////////////////////////////////////////////////
                            INTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Helper function to check if we should check for solvency in the request functions
     *
     * @param req The request action
     * @return pred if true the function should check for solvency
     */
    function _checkForSolvency(uint256 req) internal pure returns (bool pred) {
        if (req == WITHDRAW_REQUEST || req == BORROW_REQUEST) pred = true;
    }

    /**
     * @dev Due to math limitations, the amount to be sent might be a bit off. This makes sure the transfers do not fail.
     *
     * @param to The address that will receive the `IPX`.
     * @param amount The number of IPX to send.
     */
    function _safeIPXTransfer(address to, uint256 amount) internal {
        IPX.safeTransfer(to, _getIPXBalance().min(amount));
    }

    /**
     * @dev It deposits all {IPX} stored in the contract in the {IPX} pool in the {IPX_MASTER_CHEF} and returns the rewards obtained.
     *
     * @return uint256 The reward acrrued up to this block in {IPX}.
     */
    function _stakeIPX() internal returns (uint256) {
        CASA_DE_PAPEL.stake(0, _getIPXBalance());
        // The current {balanceOf} IPX is equivalent to all rewards because we just staked our entire {IPX} balance.
        return _getIPXBalance();
    }

    /**
     * @dev It withdraws an `amount` of {IPX} from the {IPX_MASTER_CHEF} and returns the rewards obtained.
     *
     * @param amount The number of {IPX} to be unstaked.
     * @return ipxHarvested The number of {IPX} that was obtained as reward.
     */
    function _unstakeIPX(uint256 amount)
        internal
        returns (uint256 ipxHarvested)
    {
        ipxHarvested = _getIPXBalance();

        CASA_DE_PAPEL.unstake(0, amount);
        // Need to subtract the previous balance and the withdrawn amount from the current {balanceOf} to know many {IPX} rewards  we got.
        ipxHarvested = _getIPXBalance() - ipxHarvested - amount;
    }

    /**
     * @dev A helper function to get the current {IPX} balance in this vault.
     */
    function _getIPXBalance() internal view returns (uint256) {
        return IERC20(IPX).balanceOf(address(this));
    }

    /**
     * @dev This function deposits {COLLATERAL} in the pool and calculates/returns the rewards obtained via the deposit function.
     *
     * @param amount The number of {COLLATERAL} to deposit in the {CASA_DE_PAPEL}.
     * @return ipxHarvested It returns how many {IPX} we got as reward from the depsit function.
     */
    function _depositFarm(uint256 amount)
        internal
        returns (uint256 ipxHarvested)
    {
        // Need to save the {balanceOf} {IPX} before the deposit function to calculate the rewards.
        ipxHarvested = _getIPXBalance() - amount;
        CASA_DE_PAPEL.stake(POOL_ID, amount);
        // Find how much IPX we earned after depositing as the deposit functions always {transfer} the pending {IPX} rewards.
        ipxHarvested = _getIPXBalance() - ipxHarvested;
    }

    /**
     * @dev It withdraws an `amount` of {COLLATERAL} from the farm. And it keeps track of the rewards obtained by using the {_getBalance} function.
     *
     * @param amount The number of {COLLATERAL} to be withdrawn from the {CASA_DE_PAPEL}.
     * @return ipxHarvested It returns the number of {IPX} tokens we got as reward.
     */
    function _withdrawFarm(uint256 amount)
        internal
        returns (uint256 ipxHarvested)
    {
        // Save the current {IPX} balance before calling the withdraw function because it will give us rewards.
        ipxHarvested = _getIPXBalance();
        CASA_DE_PAPEL.unstake(POOL_ID, amount);
        // The difference between the previous {IPX} balance and the current balance is the rewards obtained via the withdraw function.
        ipxHarvested = _getIPXBalance() - ipxHarvested;
    }

    function _deposit(address to, uint256 amount) internal {
        if (0 == amount) revert LPFreeMarket__InvalidAmount();
        if (address(0) == to) revert LPFreeMarket__InvalidAddress();

        // Save storage state in memory to save gas.
        Account memory user = userAccount[to];

        uint256 _totalAmount = totalAmount;
        uint256 _totalRewardsPerToken = totalRewardsPerToken;

        // If there are no tokens deposited, we do not have to update the current rewards.
        if (_totalAmount != 0) {
            // Get rewards currently in the {COLLATERAL} pool.
            _totalRewardsPerToken += _depositFarm(0).fdiv(_totalAmount);
            // Reinvest all {IPX} rewards into the IPX pool.
            // The functions on this block send pending {IPX} to this contract. Therefore, we need to update the {_totalRewardsPerAccount}.
            _totalRewardsPerToken += _stakeIPX().fdiv(_totalAmount);
        }

        unchecked {
            // We do not need to calculate rewards if the user has no open deposits in this contract.
            if (user.collateral != 0) {
                // Calculate and add how many rewards the user accrued.
                user.rewards += (_totalRewardsPerToken.fmul(user.collateral) -
                    user.rewardDebt).toUint128();
            }
        }

        // We want to get the tokens before updating the state
        COLLATERAL.safeTransferFrom(_msgSender(), address(this), amount);

        // Update local State
        _totalAmount += amount;

        unchecked {
            user.collateral += amount.toUint128();
        }

        // Deposit the new acquired tokens in the pool.
        // Since we already got the rewards up to this block. There should be no rewards right now to harvest.
        // Therefore, we do not need to update the {_totalRewardsPerAmount}.
        CASA_DE_PAPEL.stake(POOL_ID, amount);
        // Compound the rewards. Deposit any current {IPX} in the IPX pool.
        CASA_DE_PAPEL.stake(0, _getIPXBalance());

        // Update State to tell us that user has been completed paid up to this point.
        user.rewardDebt = _totalRewardsPerToken.fmul(user.collateral);

        // Update Global state
        userAccount[to] = user;
        totalAmount = _totalAmount.toUint128();
        totalRewardsPerToken = _totalRewardsPerToken;

        emit Deposit(_msgSender(), to, amount);
    }

    function _withdraw(
        address from,
        address collateralRecipient,
        address rewardsRecipient,
        uint256 amount
    ) internal {
        if (0 == amount) revert LPFreeMarket__InvalidAmount();

        // Save storage state in memory to save gas.
        Account memory user = userAccount[from];

        if (amount > user.collateral)
            revert LPFreeMarket__InvalidWithdrawAmount();

        // Save storage state in memory to save gas.
        uint256 _totalAmount = totalAmount;
        uint256 _totalRewardsPerToken = totalRewardsPerToken;

        // The {Vault} contract ensures that the `amount` is greater than 0.
        // It also ensured that the {totalAmount} is greater than 0.
        // We withdraw from the {CASA_DE_PAPEL} the desired `amount`.
        _totalRewardsPerToken += _withdrawFarm(amount).fdiv(_totalAmount);
        // Collect the current rewards in the {IPX} pool to properly update {_totalRewardsPerAmount}.
        _totalRewardsPerToken += _unstakeIPX(0).fdiv(_totalAmount);

        // Calculate how many rewards the user is entitled before this deposit
        uint256 rewards = _totalRewardsPerToken.fmul(user.collateral) -
            user.rewardDebt;

        unchecked {
            // Update local state
            _totalAmount -= amount;
            user.collateral -= amount.toUint128();
            // Add all accrued rewards. As this contract only sends the rewards on withdraw.
            rewards += user.rewards;
        }

        // Set rewards to 0
        user.rewards = 0;

        // Get the current {IPX} balance to make sure we have enough to cover the {IPX} the rewards.
        uint256 ipxBalance = _getIPXBalance();

        if (rewards > ipxBalance) {
            // Already took the rewards up to this block. So we do not need to update the {_totalRewardsPerAmount}.
            CASA_DE_PAPEL.unstake(0, rewards - ipxBalance);
        }

        // Send the rewards to the `from`. To make the following calculations easier
        _safeIPXTransfer(rewardsRecipient, rewards);

        uint256 newIPXBalance = _getIPXBalance();

        // Only restake if there is at least 10 {IPX} in the contract after sending the rewards.
        // If there are no {COLLATERAL} left, we do not need to restake. Because it means the vault is empty.
        if (newIPXBalance >= 10 ether) {
            // Already took the rewards up to this block. So we do not need to update the {_totalRewardsPerAmount}.
            CASA_DE_PAPEL.stake(0, newIPXBalance);
        }

        // If the Vault still has assets, we need to update the global  state as usual.
        if (_totalAmount != 0) {
            // Reset totalRewardsPerAmount if the pool is totally empty
            totalRewardsPerToken = _totalRewardsPerToken;
            user.rewardDebt = _totalRewardsPerToken.fmul(user.collateral);
            totalAmount = _totalAmount.toUint128();
        } else {
            // If the Vault does not have any {COLLATERAL}, reset the global state.
            delete totalAmount;
            delete totalRewardsPerToken;
            delete user.rewardDebt;
        }

        userAccount[from] = user;

        if (collateralRecipient != address(this))
            // Send the underlying token to the recipient
            COLLATERAL.safeTransfer(collateralRecipient, amount);

        emit Withdraw(from, collateralRecipient, rewardsRecipient, amount);
    }

    /**
     * @dev The core logic of borrow. Careful it does not accrue or check for solvency.
     *
     * @param to The address which will receive the borrowed `DINERO`
     * @param amount The number of `DINERO` to borrow
     */
    function _borrow(address to, uint256 amount) internal {
        totalPrincipal += amount.toUint128();

        if (totalPrincipal > maxBorrowAmount)
            revert LPFreeMarket__MaxBorrowAmountReached();

        unchecked {
            userPrincipal[_msgSender()] += amount;
        }

        // Note the `msg.sender` can use his collateral to lend to someone else.
        DNR.mint(to, amount);

        emit Borrow(_msgSender(), to, amount);
    }

    /**
     * @dev The core logic to repay a loan without accrueing or require checks.
     *
     * @param account The address which will have some of its principal paid back.
     * @param amount How many `DINERO` tokens (princicpal) to be paid back for the `account`
     */
    function _repay(address account, uint256 amount) internal {
        // Since all debt is in `DINERO`. We can simply burn it from the `msg.sender`
        DNR.burn(_msgSender(), amount);

        userPrincipal[account] -= amount;

        unchecked {
            totalPrincipal -= amount.toUint128();
        }

        emit Repay(_msgSender(), account, amount);
    }

    /**
     * @dev Checks if an `account` has enough collateral to back his loan based on the {maxLTVRatio}.
     *
     * @param account The address to check if he is solvent.
     * @param exchangeRate The rate to exchange {Collateral} to DNR.
     * @return bool True if the user can cover his loan. False if he cannot.
     */
    function _isSolvent(address account, uint256 exchangeRate)
        internal
        view
        returns (bool)
    {
        if (exchangeRate == 0) revert LPFreeMarket__InvalidExchangeRate();

        // How much the user has borrowed.
        uint256 principal = userPrincipal[account];

        // Account has no open loans. So he is solvent.
        if (principal == 0) return true;

        // How much collateral he has deposited.
        uint256 collateralAmount = userAccount[account].collateral;

        // Account has no collateral so he can not open any loans. He is insolvent.
        if (collateralAmount == 0) return false;

        // All Loans are emitted in `DINERO` which is based on USD price
        // Collateral in USD * {maxLTVRatio} has to be greater than principal + interest rate accrued in DINERO which is pegged to USD
        return
            collateralAmount.fmul(exchangeRate).fmul(maxLTVRatio) >= principal;
    }

    /**
     * @dev Call a function based on requestAction
     *
     * @param requestAction The action associated to a function
     * @param data The arguments to be passed to the function
     */
    function _request(uint256 requestAction, bytes calldata data) private {
        if (requestAction == DEPOSIT_REQUEST) {
            (address to, uint256 amount) = abi.decode(data, (address, uint256));
            return _deposit(to, amount);
        }

        if (requestAction == WITHDRAW_REQUEST) {
            (
                address collateralRecipient,
                address rewardsRecipient,
                uint256 amount
            ) = abi.decode(data, (address, address, uint256));
            return
                _withdraw(
                    _msgSender(),
                    collateralRecipient,
                    rewardsRecipient,
                    amount
                );
        }

        if (requestAction == BORROW_REQUEST) {
            (address to, uint256 amount) = abi.decode(data, (address, uint256));
            return _borrow(to, amount);
        }

        if (requestAction == REPAY_REQUEST) {
            (address account, uint256 principal) = abi.decode(
                data,
                (address, uint256)
            );
            return _repay(account, principal);
        }

        revert LPFreeMarket__InvalidRequest();
    }

    function _removeLiquidity(IRouter router, uint256 collateralAmount)
        private
        returns (
            address token0,
            address token1,
            uint256 amount0,
            uint256 amount1
        )
    {
        bool stable;

        {
            (token0, token1, stable, , , , , ) = IPair(address(COLLATERAL))
                .metadata();
        }

        // Even if one of the tokens is WBNB. We dont want BNB because we want to use {swapExactTokensForTokens} for Dinero after.
        // Avoids unecessary routing through WBNB {deposit} and {withdraw}.
        (amount0, amount1) = router.removeLiquidity(
            token0,
            token1,
            stable,
            collateralAmount,
            0, // The liquidator will pay for slippage
            0, // The liquidator will pay for slippage
            address(this), // The contract needs the tokens to sell them.
            //solhint-disable-next-line not-rely-on-time
            block.timestamp
        );
    }

    /**
     * @dev A helper function to sell collateral for dinero.
     *
     * @notice Slippage is not an issue because on {liquidate} we always burn the necessary amount of `DINERO`.
     * @notice We are only  using highly liquid pairs. So slippage should not be an issue. Front-running can be an issue, but the liquidation fee should cover it. It will be between 10%-15% (minus 10% for the protocol) of the debt liquidated.
     *
     * @param data arbitrary data to be passed to the swapContract
     * @param collateralAmount The amount of tokens to remove from the DEX.
     * @param principal The amount of DNR to be burned
     * @param swapContract The liquidator address to sell the collateral
     */
    function _sellCollateral(
        bytes calldata data,
        uint256 collateralAmount,
        uint256 principal,
        address swapContract
    ) private {
        IRouter router = ROUTER;

        // Even if one of the tokens is WBNB. We dont want BNB because we want to use {swapExactTokensForTokens} for Dinero after.
        // Avoids unecessary routing through WBNB {deposit} and {withdraw}.
        (
            address token0,
            address token1,
            uint256 amount0,
            uint256 amount1
        ) = _removeLiquidity(router, collateralAmount);

        // Send tokens to the swap contract
        token0.safeTransfer(swapContract, amount0);
        token1.safeTransfer(swapContract, amount1);

        ISwap(swapContract).sellTwoTokens(
            data,
            token0,
            token1,
            amount0,
            amount1,
            principal
        );
    }

    /*///////////////////////////////////////////////////////////////
                         OWNER ONLY
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev updates the {maxLTVRatio} of the whole contract.
     *
     * @param amount The new {maxLTVRatio}.
     *
     * Requirements:
     *
     * - {maxLTVRatio} cannot be higher than 90% due to the high volatility of crypto assets and we are using the overcollaterization ratio.
     * - It can only be called by the owner to avoid griefing
     *
     */
    function setMaxLTVRatio(uint256 amount) external onlyOwner {
        if (amount > 0.9e8) revert LPFreeMarket__InvalidMaxLTVRatio();
        maxLTVRatio = amount.toUint128();
        emit MaxTVLRatio(amount);
    }

    /**
     * @dev Updates the {liquidationFee}.
     *
     * @param amount The new liquidation fee.
     *
     * Requirements:
     *
     * - It cannot be higher than 15%.
     * - It can only be called by the owner to avoid griefing.
     *
     */
    function setLiquidationFee(uint256 amount) external onlyOwner {
        if (amount > 0.15e18) revert LPFreeMarket__InvalidLiquidationFee();
        liquidationFee = amount.toUint96();
        emit LiquidationFee(amount);
    }

    /**
     * @dev Sets a new value to the {maxBorrowAmount}.
     *
     * @notice Allows the {owner} to set a limit on how DNR can be created by this market.
     *
     * @param amount The new maximum amount that can be borrowed.
     *
     * Requirements:
     *
     * - Function can only be called by the {owner}
     */
    function setMaxBorrowAmount(uint256 amount) external onlyOwner {
        maxBorrowAmount = amount.toUint128();
        emit MaxBorrowAmount(amount);
    }

    /**
     * @dev Updates the treasury address.
     *
     * @param _treasury The new treasury.
     *
     * Requirements:
     *
     * - Function can only be called by the {owner}
     */
    function setTreasury(address _treasury) external onlyOwner {
        treasury = _treasury;
        emit NewTreasury(_treasury);
    }

    /**
     * @dev A hook to guard the address that can update the implementation of this contract. It must be the owner.
     */
    function _authorizeUpgrade(address)
        internal
        view
        override
        onlyOwner
    //solhint-disable-next-line no-empty-blocks
    {

    }
}
