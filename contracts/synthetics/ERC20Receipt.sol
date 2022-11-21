//SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract ERC20Receipt is ERC20 {
    address private immutable DEPLOYER;

    error ERC20Receipt__NoPermission();

    constructor(string memory name, string memory symbol) ERC20(name, symbol) {
        DEPLOYER = msg.sender;
    }

    function mint(uint256 amount) external {
        if (msg.sender != DEPLOYER) revert ERC20Receipt__NoPermission();
        _mint(msg.sender, amount);
    }

    function burn(uint256 amount) external {
        if (msg.sender != DEPLOYER) revert ERC20Receipt__NoPermission();
        _burn(msg.sender, amount);
    }
}
