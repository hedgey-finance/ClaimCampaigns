// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import '@openzeppelin/contracts/token/ERC20/ERC20.sol';

contract NonVotingToken is ERC20 {

  constructor(string memory name, string memory symbol, uint256 initialSupply) ERC20(name, symbol) {
    _mint(msg.sender, initialSupply);
  }

  function mint(uint256 amount) public {
    _mint(msg.sender, amount);
  }

}