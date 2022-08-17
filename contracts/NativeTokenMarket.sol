// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import "@interest-protocol/dex/DataTypes.sol";
import "@interest-protocol/tokens/interfaces/IDinero.sol";
import "@interest-protocol/library/MathLib.sol";
import "@interest-protocol/library/SafeCastLib.sol";
import "@interest-protocol/library/RebaseLib.sol";
import "@interest-protocol/library/SafeTransferErrors.sol";
import "@interest-protocol/library/SafeTransferLib.sol";

import "./interfaces/IPriceOracle.sol";
import "./interfaces/ISwap.sol";

import "hardhat/console.sol";

contract NativeTokenMarket is
    Initializable,
    SafeTransferErrors,
    OwnableUpgradeable,
    UUPSUpgradeable
{
    /*///////////////////////////////////////////////////////////////
                                  LIBS
    //////////////////////////////////////////////////////////////*/

    using RebaseLib for Rebase;
    using SafeTransferLib for address;
    using MathLib for uint256;
    using SafeCastLib for uint256;

    /*///////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event Deposit(address indexed from, address indexed to, uint256 amount);

    event Withdraw(address indexed from, address indexed to, uint256 amount);

    event Borrow(
        address indexed borrower,
        address indexed receiver,
        uint256 principal,
        uint256 amount
    );

    event Repay(
        address indexed payer,
        address indexed payee,
        uint256 principal,
        uint256 amount
    );

    event MaxTVLRatio(uint256);

    event LiquidationFee(uint256);

    event MaxBorrowAmount(uint256);

    event Compound(uint256 rewards, uint256 fee);

    event Accrue(uint256 accruedAmount);

    event GetDineroEarnings(address indexed treasury, uint256 amount);

    event GetCollateralEarnings(address indexed treasury, uint256 amount);

    event NewTreasury(address indexed newTreasury);

    event InterestRate(uint256 rate);

    event Liquidated(
        address indexed liquidator,
        address indexed debtor,
        uint256 principal,
        uint256 debt,
        uint256 fee,
        uint256 collateralPaid
    );

    /*///////////////////////////////////////////////////////////////
                              STRUCTS
    //////////////////////////////////////////////////////////////*/

    struct LiquidationInfo {
        uint256 allCollateral;
        uint256 allDebt;
        uint256 allPrincipal;
        uint256 allFee;
    }

    struct Account {
        uint128 collateral;
        uint128 principal;
    }

    struct LoanTerms {
        uint128 lastAccrued; // Last block in which we have calculated the total fees owed to the protocol.
        uint128 interestRate; // INTEREST_RATE is charged per second and has a base unit of 1e18.
        uint128 dnrEarned; // How many fees have the protocol earned since the last time the {owner} has collected the fees.
        uint128 collateralEarned;
    }

    /*///////////////////////////////////////////////////////////////
                                  ERRORS
    //////////////////////////////////////////////////////////////*/

    error NativeTokenMarket__InvalidMaxLTVRatio();

    error NativeTokenMarket__InvalidLiquidationFee();

    error NativeTokenMarket__MaxBorrowAmountReached();

    error NativeTokenMarket__InvalidExchangeRate();

    error NativeTokenMarket__InsolventCaller();

    error NativeTokenMarket__InvalidAmount();

    error NativeTokenMarket__InvalidAddress();

    error NativeTokenMarket__InvalidWithdrawAmount();

    error NativeTokenMarket__InvalidRequest();

    error NativeTokenMarket__InvalidLiquidationAmount();

    error NativeTokenMarket__InvalidInterestRate();

    error NativeTokenMarket__Reentrancy();

    // NO MEMORY SLOT
    // Requests
    uint256 internal constant DEPOSIT_REQUEST = 0;

    uint256 internal constant WITHDRAW_REQUEST = 1;

    uint256 internal constant BORROW_REQUEST = 2;

    uint256 internal constant REPAY_REQUEST = 3;

    /*//////////////////////////////////////////////////////////////
                       STORAGE  SLOT 0                            */

    // Dinero address
    IDinero internal DNR;

    // Basic nonreentrancy guard
    uint96 private _unlocked;
    //////////////////////////////////////////////////////////////

    /*//////////////////////////////////////////////////////////////
                       STORAGE  SLOT 1                            */

    address public treasury;

    // A fee that will be charged as a penalty of being liquidated.
    uint96 public liquidationFee;
    //////////////////////////////////////////////////////////////

    /*//////////////////////////////////////////////////////////////
                       STORAGE  SLOT 2                            */

    // Contract uses Chainlink to obtain the price in USD with 18 decimals
    IPriceOracle internal ORACLE;

    //////////////////////////////////////////////////////////////

    /*//////////////////////////////////////////////////////////////
                       STORAGE  SLOT 3                            */

    // Dinero Markets must have a max of how much DNR they can create to prevent liquidity issues during liquidations.
    uint128 public maxBorrowAmount;

    // principal + interest rate / collateral. If it is above this value, the user might get liquidated.
    uint128 public maxLTVRatio;
    //////////////////////////////////////////////////////////////

    /*//////////////////////////////////////////////////////////////
                       STORAGE  SLOT 5                            */

    Rebase public loan;

    //////////////////////////////////////////////////////////////

    /*//////////////////////////////////////////////////////////////
                       STORAGE  SLOT 6                            */

    LoanTerms public loanTerms;

    //////////////////////////////////////////////////////////////

    /*//////////////////////////////////////////////////////////////
                       STORAGE  SLOT 7                            */

    // How much principal an address has borrowed.
    mapping(address => Account) public userAccount;

    //////////////////////////////////////////////////////////////

    /*///////////////////////////////////////////////////////////////
                            INITIALIZER
    //////////////////////////////////////////////////////////////*/

    /**
     * Requirements:
     *
     * @param contracts addresses of contracts to intialize this market
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

        _unlocked = 1;
    }

    function _initializeContracts(bytes memory data) private {
        (DNR, ORACLE, treasury) = abi.decode(
            data,
            (IDinero, IPriceOracle, address)
        );
    }

    function _initializeSettings(bytes memory data) private {
        (
            maxLTVRatio,
            liquidationFee,
            maxBorrowAmount,
            loanTerms.interestRate
        ) = abi.decode(data, (uint128, uint96, uint128, uint128));
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
                ORACLE.getNativeTokenUSDPrice(1 ether) // Price of one token
            )
        ) revert NativeTokenMarket__InsolventCaller();
    }

    modifier lock() {
        if (_unlocked != 1) revert NativeTokenMarket__Reentrancy();
        _unlocked = 2;
        _;
        _unlocked = 1;
    }

    /*///////////////////////////////////////////////////////////////
                        MUTATIVE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev This function sends the collected fees by this market to the governor feeTo address.
     */
    function getDineroEarnings() external {
        // Update the total debt, includes the {loan.feesEarned}.
        _accrue();

        uint128 earnings = loanTerms.dnrEarned;

        if (earnings == 0) return;

        // Reset to 0
        loanTerms.dnrEarned = 0;

        // This can be minted. Because once users get liquidated or repay the loans. This amount will be burned (fees).
        // So it will keep the peg to USD. There must be always at bare minimum 1 USD in collateral to 1 Dinero in existence.
        DNR.mint(treasury, earnings);

        emit GetDineroEarnings(treasury, earnings);
    }

    /**
     * @dev This function collects the {COLLATERAL} earned from liquidations.
     */
    function getCollateralEarnings() external {
        uint128 earnings = loanTerms.collateralEarned;

        if (earnings == 0) return;

        // Reset to 0
        loanTerms.collateralEarned = 0;

        treasury.safeTransferNativeToken(earnings);

        emit GetCollateralEarnings(treasury, earnings);
    }

    /**
     * @dev Updates the total fees owed to the protocol and the new total borrowed with the new fees included.
     */
    function accrue() external {
        _accrue();
    }

    function deposit(address to) external payable lock {
        _deposit(to, msg.value);
    }

    function withdraw(address to, uint256 amount) external lock isSolvent {
        _accrue();
        _withdraw(to, amount);
    }

    function borrow(address to, uint256 amount) external lock isSolvent {
        _accrue();
        _borrow(to, amount);
    }

    function repay(address account, uint256 amount) external {
        _accrue();
        _repay(account, amount);
    }

    // Accept direct native token transfers
    receive() external payable lock {
        _deposit(_msgSender(), msg.value);
    }

    /**
     * @dev Function to call borrow, addCollateral, withdrawCollateral and repay in an arbitrary order
     *
     * @param requests Array of actions to denote, which function to call
     * @param requestArgs The data to pass to the function based on the request
     */
    function request(uint256[] calldata requests, bytes[] calldata requestArgs)
        external
        payable
        lock
    {
        bool checkForSolvency;
        bool checkForAccrue;
        uint256 value = msg.value;

        for (uint256 i; i < requests.length; i = i.uAdd(1)) {
            uint256 requestAction = requests[i];

            if (_checkForAccrue(requestAction) && !checkForAccrue) {
                _accrue();
                checkForAccrue = true;
            }

            if (_checkForSolvency(requestAction) && !checkForSolvency)
                checkForSolvency = true;

            if (requestAction == DEPOSIT_REQUEST) {
                (, uint256 amount) = abi.decode(
                    requestArgs[i],
                    (address, uint256)
                );
                value -= amount;
            }

            _request(requestAction, requestArgs[i]);
        }

        if (checkForSolvency)
            if (
                !_isSolvent(
                    _msgSender(),
                    ORACLE.getNativeTokenUSDPrice(1 ether) // Price of one token
                )
            ) revert NativeTokenMarket__InsolventCaller();
    }

    /**
     * @dev This function closes underwater positions. It charges the borrower a fee and rewards the liquidator for keeping the integrity of the protocol. If the data parameter is not empty, we assume it is a contract with the function {sellNativeTokenbytes,uint256,uint256)}
     * @notice Liquidator can use collateral to close the position or must have enough dinero in this account. Liquidators can only close a portion of an underwater position. We do not require the  liquidator to use the collateral. If there are any "lost" tokens in the contract. Those can be use as well.
     *
     * @param accounts The  list of accounts to be liquidated.
     * @param principals The amount of principal the `msg.sender` wants to liquidate for each account.
     * @param recipient The address that will receive the proceeds gained by liquidating.
     * @param data Arbitrary data to be passed to the swapContract
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
        bytes calldata data
    ) external lock {
        // Liquidations must be based on the current exchange rate.
        uint256 _exchangeRate = ORACLE.getNativeTokenUSDPrice(
            1 ether // Price of one token
        );

        // Need all debt to be up to date
        _accrue();

        // Save state to memory for gas saving

        LiquidationInfo memory liquidationInfo;

        Rebase memory _loan = loan;

        // Loop through all positions
        for (uint256 i; i < accounts.length; i = i.uAdd(1)) {
            address account = accounts[i];

            // If the user has enough collateral to cover his debt. He cannot be liquidated. Move to the next one.
            if (_isSolvent(account, _exchangeRate)) continue;

            Account memory _userAccount = userAccount[account];

            // Liquidator cannot repay more than the what `account` borrowed.
            // Note the liquidator does not need to close the full position.
            uint256 principal = principals[i].min(_userAccount.principal);

            unchecked {
                // The minimum value is it's own value. So this can never underflow.
                // Update the userLoan global state
                _userAccount.principal -= principal.toUint128();
            }

            // We round up to give an edge to the protocol and liquidator.
            uint256 debt = _loan.toElastic(principal, true);

            // How much collateral is needed to cover the loan + fees.
            // Since Dinero is always pegged to USD we can calculate this way.
            uint256 collateralToCover = debt.fdiv(_exchangeRate);

            // Calculate the collateralFee (for the liquidator and the protocol)
            uint256 fee = collateralToCover.fmul(liquidationFee);

            // Remove the collateral from the account. We can consider the debt paid.
            _userAccount.collateral -= (collateralToCover + fee).toUint128();

            // Update global state
            userAccount[account] = _userAccount;

            emit Liquidated(
                _msgSender(),
                account,
                principal,
                debt,
                fee,
                collateralToCover
            );

            liquidationInfo.allCollateral += collateralToCover;
            liquidationInfo.allPrincipal += principal;
            liquidationInfo.allDebt += debt;
            liquidationInfo.allFee += fee;
        }

        // There must have liquidations or we revert to not waste anymore gas.
        if (liquidationInfo.allPrincipal == 0)
            revert NativeTokenMarket__InvalidLiquidationAmount();

        // update global state
        loan = _loan.sub(
            liquidationInfo.allPrincipal,
            uint256(_loan.elastic).min(liquidationInfo.allDebt)
        );

        // 10% of the liquidation fee to be given to the protocol.
        uint256 protocolFee = liquidationInfo.allFee.fmul(0.1e18);

        unchecked {
            loanTerms.collateralEarned =
                loanTerms.collateralEarned +
                protocolFee.toUint128();
        }

        uint256 liquidatorAmount = liquidationInfo.allCollateral +
            liquidationInfo.allFee -
            protocolFee;

        recipient.safeTransferNativeToken(liquidatorAmount);

        // If the {msg.sender} calls this function with data, we assume the recipint is a contract that implements the {sellOneToken} from the ISwap interface.
        if (data.length != 0)
            ISwap(recipient).sellNativeToken(
                data,
                liquidatorAmount,
                liquidationInfo.allDebt
            );

        // This step we destroy `DINERO` equivalent to all outstanding debt. This does not include the liquidator fee.
        DNR.burn(_msgSender(), liquidationInfo.allDebt);
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
     * @dev Helper function to check if we should accrue in the request function
     *
     * @param req The request action
     * @return pred if true the function should check for solvency
     */
    function _checkForAccrue(uint256 req) internal pure returns (bool pred) {
        if (
            req == WITHDRAW_REQUEST ||
            req == BORROW_REQUEST ||
            req == REPAY_REQUEST
        ) pred = true;
    }

    function _deposit(address to, uint256 amount) internal {
        if (0 == amount) revert NativeTokenMarket__InvalidAmount();
        if (address(0) == to) revert NativeTokenMarket__InvalidAddress();

        userAccount[to].collateral += amount.toUint128();

        emit Deposit(_msgSender(), to, amount);
    }

    function _withdraw(address to, uint256 amount) internal {
        if (0 == amount) revert NativeTokenMarket__InvalidAmount();

        userAccount[_msgSender()].collateral -= amount.toUint128();

        //  We update the balance before sending, so we present reentrancy attacks.
        to.safeTransferNativeToken(amount);

        emit Withdraw(_msgSender(), to, amount);
    }

    /**
     * @dev The core logic of borrow. Careful it does not accrue or check for solvency.
     *
     * @param to The address which will receive the borrowed `DINERO`
     * @param amount The number of `DINERO` to borrow
     */
    function _borrow(address to, uint256 amount) internal {
        // What is the principal in proportion to the `amount` of Dinero based on the {loan}.
        uint256 principal;

        // Update global state
        (loan, principal) = loan.add(amount, true);

        if (loan.elastic > maxBorrowAmount)
            revert NativeTokenMarket__MaxBorrowAmountReached();

        unchecked {
            userAccount[_msgSender()].principal += principal.toUint128();
        }

        // Note the `msg.sender` can use his collateral to lend to someone else.
        DNR.mint(to, amount);

        emit Borrow(_msgSender(), to, principal, amount);
    }

    /**
     * @dev The core logic to repay a loan without accrueing or require checks.
     *
     * @param account The address which will have some of its principal paid back.
     * @param principal How many `DINERO` tokens (princicpal) to be paid back for the `account`
     */
    function _repay(address account, uint256 principal) internal {
        // Debt includes principal + accrued interest owed
        uint256 debt;

        // Update Global state
        (loan, debt) = loan.sub(principal, true);

        // Since all debt is in `DINERO`. We can simply burn it from the `msg.sender`
        DNR.burn(_msgSender(), debt);

        // Update Global state
        userAccount[account].principal -= principal.toUint128();

        emit Repay(_msgSender(), account, principal, debt);
    }

    /**
     * @dev Checks if an `account` has enough collateral to back his loan based on the {maxLTVRatio}.
     *
     * @param user The address to check if he is solvent.
     * @param exchangeRate The rate to exchange {Collateral} to DNR.
     * @return bool True if the user can cover his loan. False if he cannot.
     */
    function _isSolvent(address user, uint256 exchangeRate)
        internal
        view
        returns (bool)
    {
        if (exchangeRate == 0) revert NativeTokenMarket__InvalidExchangeRate();

        // How much the user has borrowed.
        Account memory account = userAccount[user];

        // Account has no open loans. So he is solvent.
        if (account.principal == 0) return true;

        // Account has no collateral so he can not open any loans. He is insolvent.
        if (account.collateral == 0) return false;

        // All Loans are emitted in `DINERO` which is based on USD price
        // Collateral in USD * {maxLTVRatio} has to be greater than principal + interest rate accrued in DINERO which is pegged to USD
        return
            uint256(account.collateral).fmul(exchangeRate).fmul(maxLTVRatio) >=
            loan.toElastic(account.principal, true);
    }

    function _accrue() internal {
        // Save gas save loan info to memory
        LoanTerms memory terms = loanTerms;

        // Variable to know how many blocks have passed since {loan.lastAccrued}.
        uint256 elapsedTime;

        unchecked {
            // Should never overflow.
            // Check how much time passed since the last we accrued interest
            // solhint-disable-next-line not-rely-on-time
            elapsedTime = block.timestamp - terms.lastAccrued;
        }

        // If no time has passed. There is nothing to do;
        if (elapsedTime == 0) return;

        // Update the lastAccrued time to this block
        // solhint-disable-next-line not-rely-on-time
        terms.lastAccrued = block.timestamp.toUint64();

        // Save to memory the totalLoan information for gas optimization
        Rebase memory _loan = loan;

        // If there are no open loans. We do not need to update the fees.
        if (terms.interestRate == 0 || _loan.base == 0) {
            // Save the lastAccrued time to storage and return.
            loanTerms = terms;
            return;
        }

        // Amount of tokens every borrower together owes the protocol
        // By using {fmul} at the end we get a higher precision
        uint256 debt = (uint256(_loan.elastic) * terms.interestRate).fmul(
            elapsedTime
        );

        unchecked {
            // Should not overflow.
            // Debt will eventually be paid to treasury so we update the information here.
            terms.dnrEarned += debt.toUint128();
        }

        // Update the total debt owed to the protocol
        _loan.elastic += debt.toUint128();
        // Update the loan
        loan = _loan;
        loanTerms = terms;

        emit Accrue(debt);
    }

    /**
     * @dev Call a function based on requestAction
     *
     * @param requestAction The action associated to a function
     * @param data The arguments to be passed to the function
     */
    function _request(uint256 requestAction, bytes calldata data) internal {
        if (requestAction == DEPOSIT_REQUEST) {
            (address to, uint256 amount) = abi.decode(data, (address, uint256));
            return _deposit(to, amount);
        }

        if (requestAction == WITHDRAW_REQUEST) {
            (address to, uint256 amount) = abi.decode(data, (address, uint256));
            return _withdraw(to, amount);
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

        revert NativeTokenMarket__InvalidRequest();
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
        if (amount > 0.9e18) revert NativeTokenMarket__InvalidMaxLTVRatio();
        maxLTVRatio = amount.toUint64();
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
        if (amount > 0.15e18) revert NativeTokenMarket__InvalidLiquidationFee();
        liquidationFee = amount.toUint64();
        emit LiquidationFee(amount);
    }

    /**
     * @dev Sets a new value for the interest rate.
     *
     * @notice Allows the {owner} to update the cost of borrowing DNR.
     *
     * @param amount The new interest rate.
     *
     * Requirements:
     *
     * - Function can only be called by the {owner}
     */
    function setInterestRate(uint256 amount) external onlyOwner {
        // 13e8 * 60 * 60 * 24 * 365 / 1e18 = ~ 0.0409968
        if (amount > 13e8) revert NativeTokenMarket__InvalidInterestRate();
        loanTerms.interestRate = amount.toUint128();
        emit InterestRate(amount);
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
