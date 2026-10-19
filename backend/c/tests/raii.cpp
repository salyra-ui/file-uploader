#include "salyra_upload.hpp"
#include <cassert>
#include <cstdlib>
#include <type_traits>
int main() {
  static_assert(!std::is_copy_constructible_v<salyra::engine>);
  static_assert(std::is_move_constructible_v<salyra::engine>);
  char directory[] = "/tmp/salyra-cpp-XXXXXX";
  assert(mkdtemp(directory));
  salyra::disk disk(upload_disk_new(directory));
  assert(disk);
  upload_options options{};
  options.sessions = upload_disk_sessions(disk.get());
  options.storage = upload_disk_storage(disk.get());
  options.allow_anonymous = 1;
  salyra::engine engine(options);
  auto created = engine.create(
      R"({"protocol":"salyra-upload/1","name":"empty","type":"","size":0,"lastModified":0,"chunkSize":4})",
      "cpp");
  assert(created);
  salyra::engine moved(std::move(engine));
  bool caught = false;
  try {
    moved.probe("../invalid");
  } catch (const salyra::upload_exception &error) {
    caught = error.status == 400;
  }
  assert(caught);
  return 0;
}
