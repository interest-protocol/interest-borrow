//SPDX-License-Identifier: MIT
pragma solidity 0.8.15;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/IERC20MetadataUpgradeable.sol";

import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";

import "@interest-protocol/dex/interfaces/IPair.sol";
import "@interest-protocol/library/MathLib.sol";

contract PriceOracle is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    /*///////////////////////////////////////////////////////////////
                            LIBRARIES
    //////////////////////////////////////////////////////////////*/

    using MathLib for uint256;

    /*///////////////////////////////////////////////////////////////
                              STATE
    //////////////////////////////////////////////////////////////*/

    // Token Address -> Chainlink feed with USD base.
    mapping(address => AggregatorV3Interface) public getUSDFeed;

    /*///////////////////////////////////////////////////////////////
                              EVENTS
    //////////////////////////////////////////////////////////////*/

    event NewFeed(address indexed asset, address indexed feed);

    /*///////////////////////////////////////////////////////////////
                            ERRORS
    //////////////////////////////////////////////////////////////*/

    error PriceOracle__InvalidPrice();

    error PriceOracle__InvalidAddress();

    error PriceOracle__InvalidAmount();

    error PriceOracle__MissingFeed();

    /*///////////////////////////////////////////////////////////////
                            INITIALIZER
    //////////////////////////////////////////////////////////////*/

    /**
     * Requirements:
     *
     * - Can only be called at once and should be called during creation to prevent front running.
     */
    function initialize() external initializer {
        __Ownable_init();
    }

    /**
     * @notice It calculates the price of USD of a `pair` token for an `amount` based on an fair price from Chainlink.
     * @dev Logic taken from https://github.com/AlphaFinanceLab/homora-v2/blob/e643392d582c81f6695136971cff4b685dcd2859/contracts/oracle/UniswapV2Oracle.sol#L18

     *
     * @param pair The address of a pair token.
     * @param amount The number of tokens to calculate the value in USD.
     * @return price uint256 The price of the token in USD.
     *
     * @dev It reverts if Chainlink returns a price equal or lower than 0. It also returns the value with a scaling factor of 1/1e18.
     */
    function getIPXLPTokenUSDPrice(IPair pair, uint256 amount)
        external
        view
        returns (uint256 price)
    {
        if (address(0) == address(pair)) revert PriceOracle__InvalidAddress();
        if (0 == amount) revert PriceOracle__InvalidAmount();

        (
            address token0,
            address token1,
            ,
            ,
            uint256 reserve0,
            uint256 reserve1,
            ,

        ) = pair.metadata();

        AggregatorV3Interface token0Feed = getUSDFeed[token0];
        AggregatorV3Interface token1Feed = getUSDFeed[token1];

        if (address(0) == address(token0Feed))
            revert PriceOracle__MissingFeed();

        if (address(0) == address(token1Feed))
            revert PriceOracle__MissingFeed();

        (, int256 answer0, , , ) = token0Feed.latestRoundData();
        (, int256 answer1, , , ) = token1Feed.latestRoundData();

        uint256 price0 = _toUint256(answer0).adjust(token0Feed.decimals());
        uint256 price1 = _toUint256(answer1).adjust(token1Feed.decimals());

        /// @dev If total supply is zero it should throw and revert
        // Get square root of K divided by the total supply * 2
        // This value is encoded toa uint224 to improve the accuracy
        uint256 doubleSqrtK = (reserve0 * reserve1).sqrt().mulDiv(
            2**112,
            pair.totalSupply()
        ) * 2;

        // Get fair price of LP token in USD by re-engineering the K formula.
        price = doubleSqrtK
            .mulDiv(price0.sqrt(), 2**56)
            .mulDiv(price1.sqrt(), 2**56)
            .fmul(amount);
    }

    /**
     * @notice It returns the USD value of a token for an `amount`.
     *
     * @param token The address of the token.
     * @param amount The number of tokens to calculate the value in USD.
     * @return price uint256 The price of the token in USD.
     *
     * @dev The return value has a scaling factor of 1/1e18. It will revert if Chainlink returns a value equal or lower than zero.
     */
    function getTokenUSDPrice(address token, uint256 amount)
        external
        view
        returns (uint256 price)
    {
        if (address(0) == token) revert PriceOracle__InvalidAddress();
        if (0 == amount) revert PriceOracle__InvalidAmount();

        AggregatorV3Interface feed = getUSDFeed[token];

        if (address(0) == address(feed)) revert PriceOracle__MissingFeed();

        (, int256 answer, , , ) = feed.latestRoundData();

        price = _toUint256(answer).adjust(feed.decimals()).fmul(amount);
    }

    /*///////////////////////////////////////////////////////////////
                              UTILS
    //////////////////////////////////////////////////////////////*/

    function _toUint256(int256 value) internal pure returns (uint256) {
        //  Zero Price makes no sense for an asset
        if (0 >= value) revert PriceOracle__InvalidPrice();
        return uint256(value);
    }

    /*///////////////////////////////////////////////////////////////
                            OWNER ONLY FUNCTION
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice It allows the {owner} to update the price feed for an `asset`.
     *
     * @param asset The token that will be associated with the feed.
     * @param feed The address of the chain link PriceOracle contract.
     *
     * Requirements:
     *
     * - This function has the modifier {onlyOwner} because the whole protocol depends on the quality and veracity of these feeds. It will be behind a multisig and timelock as soon as possible.
     */
    function setUSDFeed(address asset, AggregatorV3Interface feed)
        external
        onlyOwner
    {
        getUSDFeed[asset] = feed;
        emit NewFeed(asset, address(feed));
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
