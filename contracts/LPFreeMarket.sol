// SPDX-License-Identifier: MIT
pragma solidity 0.8.15;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@interest-protocol/dex/lib/DataTypes.sol";
import "@interest-protocol/dex/interfaces/IRouter.sol";
import "@interest-protocol/dex/interfaces/IPair.sol";
import "@interest-protocol/tokens/interfaces/IDinero.sol";
import "@interest-protocol/earn/interfaces/ICasaDePapel.sol";

import "./interfaces/IPriceOracle.sol";

import "./lib/DataTypes.sol";
import "./lib/Math.sol";
import "./lib/SafeCast.sol";
import "./lib/UncheckedMath.sol";

contract LPFreeMarket is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    /*///////////////////////////////////////////////////////////////
                                  LIBS
    //////////////////////////////////////////////////////////////*/

    using SafeERC20Upgradeable for IERC20Upgradeable;
    using Math for uint256;
    using SafeCast for uint256;
    using UncheckedMath for uint256;

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

    /*///////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    // Interest Swap Router address
    IRouter public ROUTER;

    // Dinero address
    IDinero public DNR;

    // Interest Swap LP token
    IERC20Upgradeable public COLLATERAL;

    ICasaDePapel public CASA_DE_PAPEL;

    // Contract uses Chainlink to obtain the price in USD with 18 decimals
    IPriceOracle public ORACLE;

    // Governance token for Interest Protocol
    IERC20Upgradeable public IPX;

    // The current master chef farm being used.
    uint256 public POOL_ID;

    // principal + interest rate / collateral. If it is above this value, the user might get liquidated.
    uint256 public maxLTVRatio;

    // A fee that will be charged as a penalty of being liquidated.
    uint256 public liquidationFee;

    // Total amount of Dinero borrowed from this contract.
    uint256 public totalPrincipal;

    // Total amount of rewards per token ever collected by this contract
    uint256 public totalRewardsPerToken;

    // total amount of staking token in the contract
    uint256 public totalAmount;

    // Dinero Markets must have a max of how much DNR they can create to prevent liquidity issues during liquidations.
    uint256 public maxBorrowAmount;

    // How much principal an address has borrowed.
    mapping(address => uint256) public userPrincipal;

    mapping(address => LPFreeMarketUser) public userAccount;

    // Requests
    uint256 internal constant DEPOSIT_REQUEST = 0;

    uint256 internal constant WITHDRAW_REQUEST = 1;

    uint256 internal constant BORROW_REQUEST = 2;

    uint256 internal constant REPAY_REQUEST = 3;

    /*///////////////////////////////////////////////////////////////
                            INITIALIZER
    //////////////////////////////////////////////////////////////*/

    /**
     * Requirements:
     *
     * @param contracts addresses of contracts to intialize this market
     * @param settings several global state uint256 variables to initialize this market
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

        (address token0, address token1, , , , , , ) = IPair(
            address(COLLATERAL)
        ).metadata();

        // We need to approve the router to {transferFrom} token0 and token1 to sell them for {DINERO}.
        IERC20Upgradeable(token0).safeApprove(
            address(ROUTER),
            type(uint256).max
        );
        IERC20Upgradeable(token1).safeApprove(
            address(ROUTER),
            type(uint256).max
        );
    }

    function _initializeContracts(bytes memory data) private {
        (ROUTER, DNR, COLLATERAL, IPX, ORACLE, CASA_DE_PAPEL) = abi.decode(
            data,
            (
                IRouter,
                IDinero,
                IERC20Upgradeable,
                IERC20Upgradeable,
                IPriceOracle,
                ICasaDePapel
            )
        );
    }

    function _initializeSettings(bytes memory data) private {
        (maxLTVRatio, liquidationFee, maxBorrowAmount, POOL_ID) = abi.decode(
            data,
            (uint256, uint256, uint256, uint256)
        );
    }

    /*///////////////////////////////////////////////////////////////
                            MODIFIERS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Check if a user loan is below the {maxLTVRatio}.
     *
     * @notice This function requires this contract to be deployed in a blockchain with low TX fees. As calling an oracle can be quite expensive.
     * @notice That the oracle is called in this function. In case of failure, liquidations, borrowing dinero and removing collateral will be disabled. Underwater loans will not be liquidated, but good news is that borrowing and removing collateral will remain closed.
     */
    modifier isSolvent() {
        _;
        if (
            !_isSolvent(
                _msgSender(),
                ORACLE.getLPTokenUSDPrice(
                    address(COLLATERAL),
                    // Interest DEX LP tokens have 18 decimals
                    1 ether
                )
            )
        ) revert LPFreeMarket__InsolventCaller();
    }

    /*///////////////////////////////////////////////////////////////
                        MUTATIVE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev This function compounds the {IPX} rewards in the pool id 0 and rewards the caller with 2% of the pending rewards.
     */
    function compound() external {
        // Variable to keep track of the {IPX} rewards we will get by depositing and unstaking.
        uint256 rewards;

        // Get rewards from the {STAKING_TOKEN} pool.
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

    function deposit(address to, uint256 amount) external {
        _deposit(to, amount);
    }

    function withdraw(address to, uint256 amount) external isSolvent {
        _withdraw(_msgSender(), to, to, amount);
    }

    function borrow(address to, uint256 amount) external isSolvent {
        _borrow(to, amount);
    }

    function repay(address account, uint256 amount) external {
        _repay(account, amount);
    }

    /**
     * @dev Function to call borrow, addCollateral, withdrawCollateral and repay in an arbitrary order
     *
     * @param requests Array of actions to denote, which function to call
     * @param requestArgs The data to pass to the function based on the request
     */
    function request(uint256[] calldata requests, bytes[] calldata requestArgs)
        external
    {
        bool checkForSolvency;

        for (uint256 i; i < requests.length; i = i.uAdd(1)) {
            uint256 requestAction = requests[i];

            if (!checkForSolvency && _checkForSolvency(requestAction))
                checkForSolvency = true;

            _request(requestAction, requestArgs[i]);
        }

        if (checkForSolvency)
            if (
                !_isSolvent(
                    _msgSender(),
                    ORACLE.getLPTokenUSDPrice(
                        address(COLLATERAL),
                        // Interest DEX LP tokens have 18 decimals
                        1 ether
                    )
                )
            ) revert LPFreeMarket__InsolventCaller();
    }

    /**
     * @dev This function closes underwater positions. It charges the borrower a fee and rewards the liquidator for keeping the integrity of the protocol
     * @notice Liquidator can use collateral to close the position or must have enough dinero in this account.
     * @notice Liquidators can only close a portion of an underwater position.
     * @notice We do not require the  liquidator to use the collateral. If there are any "lost" tokens in the contract. Those can be use as well.
     *
     * @param accounts The  list of accounts to be liquidated.
     * @param principals The amount of principal the `msg.sender` wants to liquidate for each account.
     * @param recipient The address that will receive the proceeds gained by liquidating.
     * @param path0 The list of tokens from collateral to dinero in case the `msg.sender` wishes to use collateral to cover the debt.
     * Or The list of tokens to sell the token0 if `COLLATERAL` is a PCS pair {IERC20}.
     * @param path1 The list of tokens to sell the token1 if `COLLATERAL` is a PCS pair {IERC20}.
     *
     * Requirements:
     *
     * - If the liquidator wishes to use collateral to pay off a debt. He must exchange it to Dinero.
     * - He must hold enough Dinero to cover the sum of principals if opts to not sell the collateral in PCS to avoid slippage costs.
     */
    function liquidate(
        address[] calldata accounts,
        uint256[] calldata principals,
        address recipient,
        Route[] calldata path0,
        Route[] calldata path1
    ) external {
        // Liquidations must be based on the current exchange rate.
        uint256 _exchangeRate = ORACLE.getLPTokenUSDPrice(
            address(COLLATERAL),
            // Interest DEX LP tokens have 18 decimals
            1 ether
        );

        // Save state to memory for gas saving

        LiquidationInfo memory liquidationInfo;

        uint256 _liquidationFee = liquidationFee;

        // Loop through all positions
        for (uint256 i; i < accounts.length; i = i.uAdd(1)) {
            address account = accounts[i];

            // If the user has enough collateral to cover his debt. He cannot be liquidated. Move to the next one.
            if (_isSolvent(account, _exchangeRate)) continue;

            uint256 principal;

            {
                // How much principal the user has borrowed.
                uint256 loanPrincipal = userPrincipal[account];

                // Liquidator cannot repay more than the what `account` borrowed.
                // Note the liquidator does not need to close the full position.
                principal = principals[i] > loanPrincipal
                    ? loanPrincipal
                    : principals[i];

                // Update the userLoan global state
                userPrincipal[account] -= principal;
            }

            // Calculate the collateralFee (for the liquidator and the protocol)
            uint256 fee = principal.fmul(_liquidationFee);

            // How much collateral is needed to cover the loan + fees.
            // Since Dinero is always USD we can calculate this way.
            uint256 collateralToCover = (principal + fee).fdiv(_exchangeRate);

            // Remove the collateral from the account. We can consider the debt paid.
            userAccount[account].collateral -= (collateralToCover).toUint128();

            // Get the Rewards and collateral if they are in a vault to this contract.
            // The rewards go to the `account`.
            // The collateral comes to this contract.
            // If the collateral is in this contract do nothing.

            _withdraw(account, address(this), account, collateralToCover);

            emit Repay(_msgSender(), account, principal);

            // Update local information. It should not overflow max uint128.
            liquidationInfo.allCollateral += collateralToCover;
            liquidationInfo.allPrincipal += principal.toUint128();
            liquidationInfo.allFee += fee.toUint128();
        }

        // There must have liquidations or we throw an error;
        // We throw an error instead of returning because we already changed state, sent events and withdrew tokens from collateral.
        // We need to revert all that.
        if (liquidationInfo.allPrincipal == 0)
            revert LPFreeMarket__InvalidLiquidationAmount();

        // We already substract these values from userAccount and userPrincipal mapping. So we d not need to check for underflow
        unchecked {
            // Update Global state
            totalPrincipal -= liquidationInfo.allPrincipal;
            // Update the total collateral amount.
            totalAmount -= liquidationInfo.allCollateral;
        }

        // 10% of the liquidation fee to be given to the protocol.
        uint256 protocolFee = uint256(liquidationInfo.allFee).fmul(0.1e18);

        // Liquidator can choose to sell or receive the collateral
        if (path0.length != 0 && path1.length != 0) {
            // Sell `COLLATERAL` and send trade final token to recipient.
            // Abstracted the logic to a function to avoid; Stack too deep compiler error.
            _sellCollateral(
                liquidationInfo.allCollateral,
                recipient,
                path0,
                path1
            );

            // This step we destroy `DINERO` equivalent to all outstanding debt + protocol fee. This does not include the liquidator fee.
            // Liquidator keeps the rest as profit.
            // Liquidator recipient Dinero from the swap.
            DNR.burn(_msgSender(), liquidationInfo.allPrincipal + protocolFee);
        } else {
            // This step we destroy `DINERO` equivalent to all outstanding debt + protocol fee. This does not include the liquidator fee.
            // Liquidator keeps the rest as profit.
            // Liquidator recipient Dinero from the swap.
            DNR.burn(_msgSender(), liquidationInfo.allPrincipal + protocolFee);

            COLLATERAL.safeTransfer(recipient, liquidationInfo.allCollateral);
        }
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
        uint256 balace = _getIPXBalance();

        IPX.safeTransfer(to, amount >= balace ? balace : amount);
    }

    /**
     * @dev It deposits all {IPX} stored in the contract in the {IPX} pool in the {IPX_MASTER_CHEF} and returns the rewards obtained.
     *
     * @return ipxHarvested The reward acrrued up to this block in {IPX}.
     */
    function _stakeIPX() internal returns (uint256 ipxHarvested) {
        CASA_DE_PAPEL.stake(0, _getIPXBalance());
        // Current {balanceOf} IPX are all rewards because we just staked our entire {IPX} balance.
        ipxHarvested = _getIPXBalance();
    }

    /**
     * @dev It withdraws an `amount` of {IPX} from the {IPX_MASTER_CHEF} and returns the arewards obtained.
     *
     * @param amount The number of {IPX} to be unstaked.
     * @return ipxHarvested The number of {IPX} that was obtained as reward.
     */
    function _unstakeIPX(uint256 amount)
        internal
        returns (uint256 ipxHarvested)
    {
        uint256 preBalance = _getIPXBalance();

        CASA_DE_PAPEL.unstake(0, amount);
        // Need to subtract the previous balance and withdrawn amount from the current {balanceOf} to know many reward {IPX} we got.
        ipxHarvested = _getIPXBalance() - preBalance - amount;
    }

    /**
     * @dev A helper function to get the current {IPX} balance in this vault.
     */
    function _getIPXBalance() internal view returns (uint256) {
        return IPX.balanceOf(address(this));
    }

    /**
     * @dev This function deposits {STAKING_TOKEN} in the pool and calculates/returns the rewards obtained via the deposit function.
     *
     * @param amount The number of {STAKING_TOKEN} to deposit in the {CASA_DE_PAPEL}.
     * @return ipxHarvested It returns how many {IPX} we got as reward from the depsit function.
     */
    function _depositFarm(uint256 amount)
        private
        returns (uint256 ipxHarvested)
    {
        // Need to save the {balanceOf} {IPX} before the deposit function to calculate the rewards.
        uint256 preBalance = _getIPXBalance();
        CASA_DE_PAPEL.stake(POOL_ID, amount);
        // Find how much IPX we earned after depositing as the deposit functions always {transfer} the pending {IPX} rewards.
        ipxHarvested = _getIPXBalance() - preBalance;
    }

    /**
     * @dev It withdraws an `amount` of {STAKING_TOKEN} from the pool. And it keeps track of the rewards obtained by using the {_getBalance} function.
     *
     * @param amount The number of {STAKING_TOKEN} to be withdrawn from the {CASA_DE_PAPEL}.
     * @return ipxHarvested It returns how many {IPX} we got as reward.
     */
    function _withdrawFarm(uint256 amount)
        private
        returns (uint256 ipxHarvested)
    {
        // Save the current {IPX} balance before calling the withdraw function because it will give us rewards.
        uint256 preBalance = _getIPXBalance();
        CASA_DE_PAPEL.unstake(POOL_ID, amount);
        // The difference between the previous {IPX} balance and the current balance is the rewards obtained via the withdraw function.
        ipxHarvested = _getIPXBalance() - preBalance;
    }

    function _deposit(address to, uint256 amount) internal {
        if (0 == amount) revert LPFreeMarket__InvalidAmount();
        if (address(0) == to) revert LPFreeMarket__InvalidAddress();

        // Save storage state in memory to save gas.
        LPFreeMarketUser memory user = userAccount[to];

        uint256 _totalAmount = totalAmount;
        uint256 _totalRewardsPerToken = totalRewardsPerToken;

        // If there are no tokens deposited, we do not have to update the current rewards.
        if (_totalAmount != 0) {
            // Get rewards currently in the {STAKING_TOKEN} pool.
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
        totalAmount = _totalAmount;
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
        LPFreeMarketUser memory user = userAccount[from];

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
        // If there are no {STAKING TOKENS} left, we do not need to restake. Because it means the vault is empty.
        if (_totalAmount > 0 && newIPXBalance >= 10 ether) {
            // Already took the rewards up to this block. So we do not need to update the {_totalRewardsPerAmount}.
            CASA_DE_PAPEL.stake(0, newIPXBalance);
        }

        // If the Vault still has assets, we need to update the global  state as usual.
        if (_totalAmount != 0) {
            // Reset totalRewardsPerAmount if the pool is totally empty
            totalRewardsPerToken = _totalRewardsPerToken;
            user.rewardDebt = _totalRewardsPerToken.fmul(user.collateral);
            totalAmount = _totalAmount;
        } else {
            // If the Vault does not have any {STAKING_TOKEN}, reset the global state.
            totalAmount = 0;
            totalRewardsPerToken = 0;
            user.rewardDebt = 0;
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
        totalPrincipal += amount;

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
            totalPrincipal -= amount;
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
        // How much the user has borrowed.
        uint256 principal = userPrincipal[account];

        // Account has no open loans. So he is solvent.
        if (principal == 0) return true;

        // How much collateral he has deposited.
        uint256 collateralAmount = userAccount[account].collateral;

        // Account has no collateral so he can not open any loans. He is insolvent.
        if (collateralAmount == 0) return false;

        if (exchangeRate == 0) revert LPFreeMarket__InvalidExchangeRate();

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
        returns (uint256 amount0, uint256 amount1)
    {
        address token0;
        address token1;
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
     * @param collateralAmount The amount of tokens to remove from the DEX.
     * @param recipient The address that will receive the tokens after the swap.
     * @param path0 The swap route for token0 of the pair {COLLATERAL}.
     * @param path1 The swap route for token1 of the pair {COLLATERAL}.
     */
    function _sellCollateral(
        uint256 collateralAmount,
        address recipient,
        Route[] calldata path0,
        Route[] calldata path1
    ) private {
        IRouter router = ROUTER;

        // Even if one of the tokens is WBNB. We dont want BNB because we want to use {swapExactTokensForTokens} for Dinero after.
        // Avoids unecessary routing through WBNB {deposit} and {withdraw}.
        (uint256 amount0, uint256 amount1) = _removeLiquidity(
            router,
            collateralAmount
        );

        router.swapExactTokensForTokens(
            // Sell all token0 removed from the liquidity.
            amount0,
            // The liquidator will pay for the slippage.
            0,
            // Sell token0 -> ... -> DINERO
            path0,
            // Send DINERO to the recipient. Since this has to happen in this block. We can burn right after
            recipient,
            // This TX must happen in this block.
            //solhint-disable-next-line not-rely-on-time
            block.timestamp
        );

        router.swapExactTokensForTokens(
            // Sell all token1 obtained from removing the liquidity.
            amount1,
            // The liquidator will pay for the slippage.
            0,
            // Sell token1 -> ... -> DINERO
            path1,
            // Send DINERO to the recipient. Since this has to happen in this block. We can burn right after
            recipient,
            // This TX must happen in this block.
            //solhint-disable-next-line not-rely-on-time
            block.timestamp
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
        maxLTVRatio = amount;
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
        liquidationFee = amount;
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
        maxBorrowAmount = amount;
        emit MaxBorrowAmount(amount);
    }

    /**
     * @dev A hook to guard the address that can update the implementation of this contract. It must have the {DEVELOPER_ROLE}.
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
