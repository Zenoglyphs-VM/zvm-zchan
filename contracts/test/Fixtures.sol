// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

contract NativeReceiver {
    bool public reject = true;

    function setReject(bool value) external { reject = value; }

    receive() external payable { require(!reject, "Fixture: rejected"); }
}
