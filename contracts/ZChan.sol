// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

/// @title zchan: one anonymous image board, kept entirely in this contract's logs.
///
/// A post is a call to `post`. Nothing about it is stored except whether an id
/// opened a thread: text goes out in `Posted`, the image in its own `Image`
/// event, so a page can read the whole board's text in one pass and fetch only
/// the images it is about to show. The log is the board.
///
/// Rules are the ones that make it a chan, and nothing else:
/// - a thread is opened by a post with an image; its id is its thread number;
/// - a reply names an open thread and carries a comment, an image, or both;
/// - only a thread's first post has a subject; `SAGE` on a reply asks the page
///   not to bump the thread, and means nothing on a thread's first post.
///
/// Posters are named by an eight-byte ID per thread, derived from the sender,
/// the thread, and whether the post is signed with a handle, as 4chan's
/// per-thread IDs are: the same wallet reads as the same ID within a thread and
/// as unrelated IDs across threads, and its signed and anonymous posts in one
/// thread carry two unrelated IDs, so signing never marks the anonymous ones.
/// The wallet is still the transaction's sender, public to anyone who reads the
/// chain; the ID only keeps it off the page.
///
/// A handle is this board's tripcode: a short name a wallet registers for
/// HANDLE_FEE and then signs posts with, one post at a time (`NAMED`), so
/// registering never unmasks a post the poster left anonymous. A name belongs
/// to the wallet that registered it for good, compared without case, so a
/// name on a post always means the same wallet, as a tripcode always means the
/// same password. A wallet may hold several names and post under whichever it
/// last chose; choosing one it already holds is free.
///
/// The owner takes the fees and appoints janitors, as many as it likes. A
/// janitor removes a post from the board: pages stop showing it (they follow
/// `Removed`), and a removed thread takes no more replies. A poster can delete
/// their own post the same way (`Deleted`), for good: no janitor can restore
/// it. Either way, what was posted stays in the chain's history; no contract
/// can erase a log.
contract ZChan {
    uint256 public constant MAX_SUBJECT = 100;
    uint256 public constant MAX_BODY = 4000;
    uint256 public constant MAX_IMAGE = 65536;
    uint256 public constant HANDLE_FEE = 1 ether; // 1 ZNN
    uint256 public constant MIN_HANDLE = 2;
    uint256 public constant MAX_HANDLE = 16;

    uint8 public constant SAGE = 1;
    uint8 public constant NAMED = 2;

    /// The block this board was created in, where a reader starts its scan.
    uint256 public immutable startBlock;

    /// The number of posts so far, which is also the last post's id.
    uint64 public posts;
    address public owner;

    /// Who may remove posts. The page learns the set from `JanitorSet`.
    mapping(address => bool) public janitors;

    /// Whether an id is the first post of a thread, so a reply can be checked
    /// against a thread that exists.
    mapping(uint64 => bool) public isThread;
    /// Posts a janitor removed, and has not restored.
    mapping(uint64 => bool) public removed;
    /// The name a wallet posts under when it signs a post; "" for none.
    mapping(address => string) public handleOf;
    /// Who holds a name, by the hash of its lowercase form.
    mapping(bytes32 => address) public holderOf;
    /// Who sent each post, so only they can delete it. Not public: the sender
    /// is on the chain anyway, but nothing here should make it one call away.
    mapping(uint64 => address) private authorOf;
    /// Posts their own poster deleted.
    mapping(uint64 => bool) public deleted;

    event Posted(
        uint64 indexed id,
        uint64 indexed thread,
        bytes8 indexed poster,
        bool sage,
        uint32 imageBytes,
        string name,
        string subject,
        string body
    );
    event Image(uint64 indexed id, bytes data);
    event Removed(uint64 indexed id, bool removed);
    event Deleted(uint64 indexed id);
    event HandleChosen(address indexed holder, string name, bool registered);
    event JanitorSet(address indexed janitor, bool active);
    event OwnerChanged(address indexed owner);
    event Withdrawn(address indexed to, uint256 amount);

    error SubjectTooLong();
    error BodyTooLong();
    error ImageTooLarge();
    error ThreadNeedsImage();
    error EmptyReply();
    error ReplyHasSubject();
    error NoSuchThread();
    error ThreadRemoved();
    error NoSuchPost();
    error NotYourPost();
    error NoHandle();
    error BadHandle();
    error HandleTaken();
    error WrongFee();
    error NotJanitor();
    error NotOwner();
    error TransferFailed();

    constructor(address owner_, address janitor_) {
        startBlock = block.number;
        owner = owner_;
        emit OwnerChanged(owner_);
        if (janitor_ != address(0)) {
            janitors[janitor_] = true;
            emit JanitorSet(janitor_, true);
        }
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// Posts to the board. `thread` is 0 to open a thread, or the thread
    /// replied to. `flags` holds SAGE and NAMED. Returns the new post's id.
    function post(uint64 thread, uint8 flags, string calldata subject, string calldata body, bytes calldata image)
        external
        returns (uint64 id)
    {
        if (bytes(subject).length > MAX_SUBJECT) revert SubjectTooLong();
        if (bytes(body).length > MAX_BODY) revert BodyTooLong();
        if (image.length > MAX_IMAGE) revert ImageTooLarge();

        id = ++posts;
        if (thread == 0) {
            if (image.length == 0) revert ThreadNeedsImage();
            thread = id;
            flags &= ~SAGE;
            isThread[id] = true;
        } else {
            if (!isThread[thread]) revert NoSuchThread();
            if (removed[thread] || deleted[thread]) revert ThreadRemoved();
            if (bytes(subject).length != 0) revert ReplyHasSubject();
            if (bytes(body).length == 0 && image.length == 0) revert EmptyReply();
        }

        authorOf[id] = msg.sender;
        bool named = flags & NAMED != 0;
        string memory name;
        if (named) {
            name = handleOf[msg.sender];
            if (bytes(name).length == 0) revert NoHandle();
        }
        emit Posted(
            id,
            thread,
            bytes8(keccak256(abi.encode(msg.sender, thread, named))),
            flags & SAGE != 0,
            uint32(image.length),
            name,
            subject,
            body
        );
        if (image.length != 0) emit Image(id, image);
    }

    /// Chooses the name this wallet signs posts with. A name nobody holds is
    /// registered to the sender for HANDLE_FEE; one the sender already holds
    /// is chosen again for nothing.
    function register(string calldata name) external payable {
        bytes32 key = handleKey(name);
        address held = holderOf[key];
        bool fresh = held == address(0);
        if (fresh) {
            if (msg.value != HANDLE_FEE) revert WrongFee();
            holderOf[key] = msg.sender;
        } else {
            if (held != msg.sender) revert HandleTaken();
            if (msg.value != 0) revert WrongFee();
        }
        handleOf[msg.sender] = name;
        emit HandleChosen(msg.sender, name, fresh);
    }

    /// Who holds a name, compared without case; address(0) if it is free.
    /// Reverts for a string that could never be a name.
    function holder(string calldata name) external view returns (address) {
        return holderOf[handleKey(name)];
    }

    /// The key a name is held under: the hash of its lowercase form, after
    /// checking it is 2 to 16 characters of A-Z, a-z, 0-9 and underscore.
    /// Nothing else is allowed, so two names cannot look alike.
    function handleKey(string calldata name) public pure returns (bytes32) {
        bytes memory b = bytes(name);
        if (b.length < MIN_HANDLE || b.length > MAX_HANDLE) revert BadHandle();
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (c >= 'A' && c <= 'Z') b[i] = bytes1(uint8(c) + 32);
            else if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_')) revert BadHandle();
        }
        return keccak256(b);
    }

    /// Deletes one of the sender's own posts from the board, for good.
    function deletePost(uint64 id) external {
        if (authorOf[id] != msg.sender) revert NotYourPost();
        deleted[id] = true;
        emit Deleted(id);
    }

    /// Removes a post from the board, or restores it.
    function remove(uint64 id, bool gone) external {
        if (!janitors[msg.sender]) revert NotJanitor();
        if (id == 0 || id > posts) revert NoSuchPost();
        removed[id] = gone;
        emit Removed(id, gone);
    }

    /// Makes an address a janitor, or stops it being one.
    function setJanitor(address who, bool active) external onlyOwner {
        janitors[who] = active;
        emit JanitorSet(who, active);
    }

    /// Hands the board to another owner; address(0) gives it up for good.
    function setOwner(address next) external onlyOwner {
        owner = next;
        emit OwnerChanged(next);
    }

    /// Sends `amount` of the fees collected to `to`; 0 sends all of them.
    function withdraw(address payable to, uint256 amount) external onlyOwner {
        if (amount == 0) amount = address(this).balance;
        emit Withdrawn(to, amount);
        (bool ok, ) = to.call{value: amount}('');
        if (!ok) revert TransferFailed();
    }
}
